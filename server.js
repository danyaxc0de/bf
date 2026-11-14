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
const APP_URL = process.env.APP_URL || 'https://bf-k8rg.onrender.com';

init().then((database) => {
  console.log('База данных готова к работе!');
  global.db = database;

  const { requireAuth } = require('./auth');
  const { fullUsernameCheck, isValidFormat } = require('./telegram');
  const { evaluateUsername } = require('./scoring');

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
      } else {
        // Проверяем, есть ли реф-код, если нет - создаем
        const refRow = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(dbUser.id);
        if (!refRow) {
          const code = Math.random().toString(36).slice(2, 8).toUpperCase();
          global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(dbUser.id, code, Date.now());
        }
      }

      const token = jwt.sign({ userId: dbUser.id }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
      res.json({ token, tier: dbUser.tier, coins: dbUser.coins, custom_music_url: dbUser.custom_music_url });
    } catch (e) { res.status(500).json({ error: 'Ошибка авторизации: ' + e.message }); }
  });

  app.get('/referral/me', requireAuth, (req, res) => {
    const row = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'Реф. код не найден' });
    res.json({ code: row.code, link: `${APP_URL}/r/${row.code}`, invited: 0 });
  });

  // --- ОСТАЛЬНОЙ КОД (ГЕНЕРАТОР, ПОИСК, ПРОФИЛЬ, ОПЛАТА) ---
  // (Оставь без изменений, я его не трогал)

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер на порту ${PORT}`);
    const { startScanner } = require('./scanner');
    startScanner({ intervalMs: 10000 });
    try { spawn('python3', ['bot.py']); } catch (e) {}
  });
});
