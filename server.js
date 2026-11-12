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
      const info = global.db.prepare('INSERT INTO users (telegram_id, tier, created_at) VALUES (?, ?, ?)').run(login, 'free', Date.now());
      const token = jwt.sign({ userId: info.lastInsertRowid }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
      res.json({ token });
    } catch (e) { res.status(500).json({ error: 'Пользователь уже существует' }); }
  });

  app.post('/auth/login', (req, res) => {
    const { login, password } = req.body;
    const user = global.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(login);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'super_secret_key_12345', { expiresIn: '7d' });
    res.json({ token });
  });

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

  app.get('/pool/top-finds', (req, res) => {
    const rows = global.db.prepare(`SELECT * FROM found_usernames WHERE is_hidden = 0 ORDER BY score DESC LIMIT 50`).all();
    res.json(rows);
  });

  app.get('/admin/finds', requireAuth, (req, res) => {
    const user = global.db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(req.user.id);
    if (!ADMIN_IDS.includes(user.telegram_id)) return res.status(403).json({ error: 'Доступ запрещен' });
    const rows = global.db.prepare(`SELECT * FROM found_usernames ORDER BY found_at DESC`).all();
    res.json(rows);
  });

  app.post('/admin/toggle-hide/:id', requireAuth, (req, res) => {
    const user = global.db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(req.user.id);
    if (!ADMIN_IDS.includes(user.telegram_id)) return res.status(403).json({ error: 'Доступ запрещен' });
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
