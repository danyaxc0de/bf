const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { spawn } = require('child_process');
const { init } = require('./db'); // Изменено для новой БД

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use(globalLimiter);

const DAILY_LIMIT_FREE = 5;
const DAILY_LIMIT_PREMIUM = 100;
const TRIAL_DAYS = 3;

// --- АВТОРИЗАЦИЯ ---
app.post('/auth/telegram-init', (req, res) => {
  const { createAuthToken } = require('./auth');
  const token = createAuthToken();
  const botUsername = process.env.PREMIUM_BOT_USERNAME;
  res.json({ url: `https://t.me/${botUsername}?start=auth_${token}` });
});

app.post('/auth/telegram-confirm', async (req, res) => {
  const { confirmAuthToken } = require('./auth');
  const { token, telegram_id } = req.body;
  if (!token || !telegram_id) return res.status(400).json({ error: 'Нет данных' });
  const jwtToken = confirmAuthToken(token, telegram_id);
  if (!jwtToken) return res.status(400).json({ error: 'Токен неверный или уже использован' });
  res.json({ token: jwtToken });
});

// --- ПРОВЕРКА ЮЗЕРНЕЙМА ---
app.get('/check/:username', async (req, res) => {
  const { requireAuth } = require('./auth');
  const { fullUsernameCheck, isValidFormat } = require('./telegram');
  const { evaluateUsername } = require('./scoring');
  
  // Простая проверка авторизации (нужен db в auth)
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нужна авторизация' });

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

app.get('/referral/me', (req, res) => {
  const { requireAuth } = require('./auth');
  const db = require('./db');
  const row = db.prepare('SELECT code FROM referrals WHERE user_id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Реф. код не найден' });
  const invitedCount = db.prepare('SELECT COUNT(*) as cnt FROM referrals WHERE referred_by_code = ?').get(row.code).cnt;
  res.json({ code: row.code, link: `${APP_URL}/?ref=${row.code}`, invited: invitedCount, bonusPerInvite: '3 дня Premium обоим' });
});

// --- ЗАПУСК ---
const PORT = process.env.PORT || 3000;

init().then((database) => {
  console.log('База данных готова к работе!');

  // Прокидываем db в модули (пока просто через global, но лучше переписать auth и scanner на передачу db)
  global.db = database;

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
