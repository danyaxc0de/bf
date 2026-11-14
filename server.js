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

const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://bf-k8rg.onrender.com';
const BOT_USERNAME = 'skupgoldi25gfor1starbot';
const ADMIN_ID = '8192413936'; // Твой Telegram ID

if (!process.env.JWT_SECRET) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Не задан JWT_SECRET в переменных окружения!");
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;

init().then((database) => {
  console.log('База данных готова к работе!');
  global.db = database;

  global.db.exec(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      value INTEGER,
      uses_left INTEGER,
      type TEXT
    );
  `);

  const { requireAuth } = require('./auth');
  const { fullUsernameCheck, isValidFormat } = require('./telegram');
  const { evaluateUsername } = require('./scoring');

  // --- АДМИН ЭНДПОИНТЫ (ТОЛЬКО ПО ID) ---
  app.post('/admin/give-premium', (req, res) => {
    const { admin_id, target_id, days } = req.body;
    if (String(admin_id) !== ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });

    try {
      const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(target_id));
      if (!user) return res.status(404).json({ error: 'Юзер не найден в базе (пусть зайдет в WebApp)' });
      
      const daysMs = days * 24 * 60 * 60 * 1000;
      const newPremium = (user.premium_until || Date.now()) + daysMs;
      
      global.db.prepare('UPDATE users SET tier = ?, premium_until = ? WHERE id = ?').run('premium', newPremium, user.id);
      res.json({ ok: true, expires: new Date(newPremium).toLocaleDateString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/admin/remove-premium', (req, res) => {
    const { admin_id, target_id } = req.body;
    if (String(admin_id) !== ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });

    try {
      const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(target_id));
      if (!user) return res.status(404).json({ error: 'Юзер не найден' });
      
      global.db.prepare('UPDATE users SET tier = ?, premium_until = ? WHERE id = ?').run('free', null, user.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // ---------------------------------

  app.post('/auth/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполни все поля' });
    try {
      const info = global.db.prepare('INSERT INTO users (telegram_id, password, tier, created_at, coins) VALUES (?, ?, ?, ?, ?)').run(login, password, 'free', Date.now(), 30);
      const userId = info.lastInsertRowid;
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
      const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, coins: 30 });
    } catch (e) { res.status(500).json({ error: 'Логин занят' }); }
  });

  app.post('/auth/login', (req, res) => {
    const { login, password } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(login);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.password && user.password !== password) return res.status(401).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, tier: user.tier, coins: user.coins, custom_music_url: user.custom_music_url });
  });

  app.post('/auth/telegram-webapp', (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'Нет данных' });
    try {
      const urlParams = new URLSearchParams(initData);
      const tgUser = JSON.parse(urlParams.get('user'));
      let dbUser = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(tgUser.id));
      
      if (!dbUser) {
        const info = global.db.prepare('INSERT INTO users (telegram_id, tier, created_at, coins) VALUES (?, ?, ?, ?)').run(String(tgUser.id), 'free', Date.now(), 30);
        const userId = info.lastInsertRowid;
        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
        global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
        dbUser = global.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      } else {
        let refRow = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(dbUser.id);
        if (!refRow) {
          const code = Math.random().toString(36).slice(2, 8).toUpperCase();
          global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(dbUser.id, code, Date.now());
        }
      }

      const token = jwt.sign({ userId: dbUser.id }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, tier: dbUser.tier, coins: dbUser.coins, custom_music_url: dbUser.custom_music_url });
    } catch (e) { res.status(500).json({ error: 'Ошибка авторизации: ' + e.message }); }
  });

  app.post('/referral/register-click', (req, res) => {
    const { ref_code, new_user_id } = req.body;
    try {
      const row = global.db.prepare('SELECT user_id FROM referrals WHERE code = ?').get(ref_code);
      if (row && String(row.user_id) !== String(new_user_id)) {
        global.db.prepare('UPDATE users SET coins = coins + 15 WHERE id = ?').run(row.user_id);
        res.json({ ok: true });
      } else {
        res.json({ ok: false });
      }
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/user/set-music', requireAuth, (req, res) => {
    const { url } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.tier !== 'premium' && (!user.premium_until || user.premium_until < Date.now())) return res.status(403).json({ error: 'Только для Premium' });
    global.db.prepare('UPDATE users SET custom_music_url = ? WHERE id = ?').run(url, req.user.id);
    res.json({ ok: true });
  });

  app.get('/search-by-name/:name', requireAuth, searchLimiter, async (req, res) => {
    try {
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
        if (check.status === 'free') { const { total } = evaluateUsername(username); results.push({ username, score: total }); }
        await new Promise(r => setTimeout(r, 200));
      }
      results.sort((a, b) => b.score - a.score);
      res.json({ base: baseName, results, coinsLeft: user.coins - 20 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/generate-random', requireAuth, searchLimiter, async (req, res) => {
    try {
      const user = global.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (user.coins < 10) return res.status(403).json({ error: 'Недостаточно ЮК' });
      global.db.prepare('UPDATE users SET coins = coins - 10 WHERE id = ?').run(user.id);
      const chars = 'abcdefghiklmnoprstuvwxy';
      let randomUsername = '';
      for (let j = 0; j < 5; j++) randomUsername += chars.charAt(Math.floor(Math.random() * chars.length));
      const check = await fullUsernameCheck(randomUsername);
      let score = 0; let status = 'taken';
      if (check.status === 'free') { const evalResult = evaluateUsername(randomUsername); score = evalResult.total; status = 'free'; }
      res.json({ result: { username: randomUsername, score, status }, coinsLeft: user.coins - 10 });
    } catch (e) { 
      console.error("Ошибка генерации:", e);
      res.status(500).json({ error: 'Ошибка сервера: ' + e.message }); 
    }
  });

  app.get('/pool/top-finds', (req, res) => res.json(global.db.prepare(`SELECT * FROM found_usernames WHERE is_hidden = 0 ORDER BY score DESC LIMIT 50`).all()));
  
  app.get('/referral/me', requireAuth, (req, res) => {
    try {
      const row = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
      if (!row) {
        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
        global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(req.user.id, code, Date.now());
        return res.json({ code: code, link: `https://t.me/${BOT_USERNAME}?start=${code}`, invited: 0 });
      }
      res.json({ code: row.code, link: `https://t.me/${BOT_USERNAME}?start=${row.code}`, invited: 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/promo/redeem', requireAuth, (req, res) => {
    const { code } = req.body;
    try {
      const promo = global.db.prepare('SELECT * FROM promo_codes WHERE code = ? AND uses_left > 0').get(code);
      if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
      if (promo.type === 'coins') global.db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(promo.value, req.user.id);
      global.db.prepare('UPDATE promo_codes SET uses_left = uses_left - 1 WHERE code = ?').run(code);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/top/users', (req, res) => res.json(global.db.prepare('SELECT telegram_id, coins FROM users ORDER BY coins DESC LIMIT 10').all()));
  app.get('/top/hunters', (req, res) => res.json(global.db.prepare(`SELECT claimed_by, COUNT(*) as count FROM found_usernames WHERE claimed_by IS NOT NULL AND claimed_by != 'ADMIN' GROUP BY claimed_by ORDER BY count DESC LIMIT 10`).all()));

  app.post('/auth/premium-webhook', (req, res) => {
    const { telegram_id, plan, type } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (type === 'coins') {
      const coinsToAdd = plan === 'coins_50' ? 50 : plan === 'coins_150' ? 150 : 500;
      global.db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coinsToAdd, user.id);
    } else {
      const days = plan === 'day' ? 1 : plan === 'week' ? 7 : plan === 'month' ? 30 : 36500;
      const bonus = plan === 'day' ? 20 : plan === 'week' ? 150 : plan === 'month' ? 500 : 1000;
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
