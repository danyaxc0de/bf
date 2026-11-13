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

  app.post('/auth/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполни все поля' });
    try {
      const info = global.db.prepare('INSERT INTO users (telegram_id, tier, created_at, coins) VALUES (?, ?, ?, ?)').run(login, 'free', Date.now(), 30);
      const token = jwt.sign({ userId: info.lastInsertRowid }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
      res.json({ token, coins: 30 });
    } catch (e) { res.status(500).json({ error: 'Логин занят' }); }
  });

  app.post('/auth/login', (req, res) => {
    const { login, password } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(login);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
    res.json({ token, tier: user.tier, coins: user.coins, profile_username: user.profile_username });
  });

  app.get('/search-by-name/:name', requireAuth, async (req, res) => {
    const user = global.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.coins < 10) return res.status(403).json({ error: 'Недостаточно ЮК' });

    const baseName = req.params.name.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (baseName.length < 2) return res.status(400).json({ error: 'Имя короткое' });

    global.db.prepare('UPDATE users SET coins = coins - 10 WHERE id = ?').run(user.id);

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
    res.json({ base: baseName, results, coinsLeft: user.coins - 10 });
  });

  app.get('/pool/top-finds', (req, res) => {
    res.json(global.db.prepare(`SELECT * FROM found_usernames WHERE is_hidden = 0 ORDER BY score DESC LIMIT 50`).all());
  });

  app.post('/user/set-username', requireAuth, (req, res) => {
    const { username } = req.body;
    const check = global.db.prepare('SELECT * FROM found_usernames WHERE username = ? AND is_hidden = 0').get(username);
    if (!check) return res.status(400).json({ error: 'Этот ник нельзя поставить' });

    global.db.prepare('UPDATE users SET profile_username = ? WHERE id = ?').run(username, req.user.id);
    res.json({ ok: true });
  });

  app.post('/messages/send', requireAuth, (req, res) => {
    const { receiver_id, text } = req.body;
    if (!receiver_id || !text) return res.status(400).json({ error: 'Пустое сообщение' });
    global.db.prepare('INSERT INTO messages (sender_id, receiver_id, text, created_at) VALUES (?, ?, ?, ?)').run(req.user.id, receiver_id, text, Date.now());
    res.json({ ok: true });
  });

  app.get('/top/users', (req, res) => {
    const users = global.db.prepare('SELECT telegram_id, coins FROM users ORDER BY coins DESC LIMIT 10').all();
    res.json(users);
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

  app.get('/referral/me', requireAuth, (req, res) => {
    const row = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'Реф. код не найден' });
    res.json({ code: row.code, link: `${APP_URL}/r/${row.code}`, invited: 0 });
  });

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
