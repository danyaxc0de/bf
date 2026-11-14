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
    try {
      const info = global.db.prepare('INSERT INTO users (telegram_id, password, tier, created_at, coins) VALUES (?, ?, ?, ?, ?)').run(login, password, 'free', Date.now(), 30);
      const userId = info.lastInsertRowid;
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
      const token = jwt.sign({ userId }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
      res.json({ token, coins: 30 });
    } catch (e) { res.status(500).json({ error: 'Логин занят' }); }
  });

  app.post('/auth/login', (req, res) => {
    const { login, password } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(login);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.password && user.password !== password) return res.status(401).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
    res.json({ token, tier: user.tier, coins: user.coins, custom_music_url: user.custom_music_url });
  });

  // --- ВХОД ЧЕРЕЗ TELEGRAM WEBAPP ---
  app.post('/auth/telegram-webapp', (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'Нет данных' });
    try {
      const urlParams = new URLSearchParams(initData);
      const user = JSON.parse(urlParams.get('user'));
      let dbUser = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(user.id));
      if (!dbUser) {
        const info = global.db.prepare('INSERT INTO users (telegram_id, tier, created_at, coins) VALUES (?, ?, ?, ?)').run(String(user.id), 'free', Date.now(), 30);
        const userId = info.lastInsertRowid;
        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
        global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
        dbUser = global.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      }
      const token = jwt.sign({ userId: dbUser.id }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
      res.json({ token, tier: dbUser.tier, coins: dbUser.coins, custom_music_url: dbUser.custom_music_url });
    } catch (e) { res.status(500).json({ error: 'Ошибка авторизации' }); }
  });

  // --- СВОЯ МУЗЫКА (ТОЛЬКО PREMIUM) ---
  app.post('/user/set-music', requireAuth, (req, res) => {
    const { url } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    
    if (user.tier !== 'premium' && (!user.premium_until || user.premium_until < Date.now())) {
      return res.status(403).json({ error: 'Только для Premium' });
    }

    global.db.prepare('UPDATE users SET custom_music_url = ? WHERE id = ?').run(url, req.user.id);
    res.json({ ok: true });
  });

  // --- ПОИСК И ГЕНЕРАЦИЯ ---
  app.get('/search-by-name/:name', requireAuth, async (req, res) => {
    const user = global.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.coins < 20) return res.status(403).json({ error: 'Недостаточно ЮК (нужно 20)' });

    const baseName = req.params.name.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (baseName.length < 2) return res.status(400).json({ error: 'Имя короткое' });

    global.db.prepare('UPDATE users SET coins = coins - 20 WHERE id = ?').run(user.id);

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
    res.json({ base: baseName, results, coinsLeft: user.coins - 20 });
  });

  app.get('/generate-random', requireAuth, async (req, res) => {
    const user = global.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.coins < 10) return res.status(403).json({ error: 'Недостаточно ЮК' });

    global.db.prepare('UPDATE users SET coins = coins - 10 WHERE id = ?').run(user.id);

    const chars = 'abcdefghiklmnoprstuvwxy';
    let randomUsername = '';
    for (let j = 0; j < 5; j++) {
      randomUsername += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    const check = await fullUsernameCheck(randomUsername);
    let score = 0;
    let status = 'taken';

    if (check.status === 'free') {
      const evalResult = evaluateUsername(randomUsername);
      score = evalResult.total;
      status = 'free';
    }
    
    res.json({ result: { username: randomUsername, score, status }, coinsLeft: user.coins - 10 });
  });

  // --- НАХОДКИ И ТОПЫ ---
  app.get('/pool/top-finds', (req, res) => {
    res.json(global.db.prepare(`SELECT * FROM found_usernames WHERE is_hidden = 0 ORDER BY score DESC LIMIT 50`).all());
  });

  app.get('/referral/me', requireAuth, (req, res) => {
    const row = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'Реф. код не найден' });
    res.json({ code: row.code, link: `${APP_URL}/r/${row.code}`, invited: 0 });
  });

  app.post('/promo/redeem', requireAuth, (req, res) => {
    const { code } = req.body;
    const promo = global.db.prepare('SELECT * FROM promo_codes WHERE code = ? AND uses_left > 0').get(code);
    if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
    
    if (promo.type === 'coins') {
      global.db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(promo.value, req.user.id);
    }
    global.db.prepare('UPDATE promo_codes SET uses_left = uses_left - 1 WHERE code = ?').run(code);
    res.json({ ok: true });
  });

  app.get('/top/users', (req, res) => {
    res.json(global.db.prepare('SELECT telegram_id, coins FROM users ORDER BY coins DESC LIMIT 10').all());
  });

  app.get('/top/hunters', (req, res) => {
    const hunters = global.db.prepare(`
      SELECT claimed_by, COUNT(*) as count 
      FROM found_usernames 
      WHERE claimed_by IS NOT NULL AND claimed_by != 'ADMIN' 
      GROUP BY claimed_by 
      ORDER BY count DESC LIMIT 10
    `).all();
    res.json(hunters);
  });

  // --- ОПЛАТА ---
  app.post('/auth/premium-webhook', (req, res) => {
    const { telegram_id, plan, type } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (type === 'coins') {
      const coinsToAdd = plan === 'coins_50' ? 50 : plan === 'coins_150' ? 150 : 500;
      global.db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coinsToAdd, user.id);
    } else {
      const days = plan === 'day' ? 1 : plan === 'week' ? 7 : plan === 'month' ? 30 : 36500;
      const bonus = plan === 'day' ? 20 : plan === 'week' ? 150 : plan === 'month' ? 700 : 5000;
      const newPremium = (user.premium_until || Date.now()) + (days * 24 * 60 * 60 * 1000);
      global.db.prepare('UPDATE users SET tier = ?, premium_until = ?, coins = coins + ? WHERE id = ?').run('premium', newPremium, bonus, user.id);
    }
    res.json({ ok: true });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер на порту ${PORT}`);
    const { startScanner } = require('./scanner');
    startScanner({ intervalMs: 10000 });
    try { spawn('python3', ['bot.py']); } catch (e) {}
  });
});
