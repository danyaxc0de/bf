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

init().then((database) => {
  console.log('База данных готова к работе!');
  global.db = database;

  const { requireAuth, logAction, countRecentActions } = require('./auth');
  const { fullUsernameCheck, isValidFormat } = require('./telegram');
  const { evaluateUsername } = require('./scoring');

  // --- РЕГИСТРАЦИЯ И ВХОД ---
  app.post('/auth/register', (req, res) => {
    const { login, password, ref } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполни все поля' });
    
    try {
      const info = global.db.prepare('INSERT INTO users (telegram_id, tier, created_at) VALUES (?, ?, ?)').run(login, 'free', Date.now());
      const userId = info.lastInsertRowid;
      
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      global.db.prepare('INSERT INTO referrals (user_id, code, created_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
      
      const token = jwt.sign({ userId }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
      res.json({ token });
    } catch (e) {
      res.status(500).json({ error: 'Пользователь уже существует' });
    }
  });

  app.post('/auth/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполни все поля' });
    
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(login);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
    res.json({ token });
  });

  // --- ПРОВЕРКА ЮЗЕРНЕЙМА ---
  app.get('/check/:username', async (req, res) => {
    const username = req.params.username.replace('@', '');
    if (!isValidFormat(username)) return res.status(400).json({ error: 'Некорректный формат' });

    const result = await fullUsernameCheck(username);
    if (result.status === 'free' || result.status === 'fragment_sale' || result.status === 'fragment_locked') {
      const { total, breakdown } = evaluateUsername(username);
      result.score = total;
      result.score_breakdown = breakdown;
    }
    res.json(result);
  });

  // --- РЕФЕРАЛКИ ---
  const APP_URL = process.env.APP_URL || 'https://bubfind.app';
  app.get('/referral/me', requireAuth, (req, res) => {
    const row = global.db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'Реф. код не найден' });
    res.json({ code: row.code, link: `${APP_URL}/?ref=${row.code}`, invited: 0, bonusPerInvite: '3 дня Premium обоим' });
  });

  // --- ЗАПУСК ---
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер на порту ${PORT}`);
    const { startScanner } = require('./scanner');
    startScanner({ intervalMs: 4000 });

    try {
      const botProcess = spawn('python3', ['bot.py']);
      botProcess.stdout.on('data', (data) => console.log(`[BOT]: ${data}`));
      botProcess.stderr.on('data', (data) => console.error(`[BOT ERROR]: ${data}`));
    } catch (e) {
      console.error('Не удалось запустить бота:', e);
    }
  });
});
