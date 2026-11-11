const { fullUsernameCheck, isValidFormat } = require('./telegram');
const { evaluateUsername } = require('./scoring');
const db = require('./db');

function startScanner({ intervalMs = 4000 } = {}) {
  console.log('Сканер запущен...');
  
  setInterval(async () => {
    try {
      const randomUsername = 'user' + Math.random().toString(36).slice(2, 8);
      
      if (!isValidFormat(randomUsername)) return;
      
      const result = await fullUsernameCheck(randomUsername);
      
      if (result.status === 'free' || result.status === 'fragment_sale') {
        const { total, breakdown } = evaluateUsername(randomUsername);
        
        const existing = db.prepare('SELECT id FROM found_usernames WHERE username = ?').get(randomUsername);
        if (!existing) {
          db.prepare(`
            INSERT INTO found_usernames 
            (username, length, score, score_breakdown, status, fragment_price, found_at, last_checked_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUsername, randomUsername.length, total, JSON.stringify(breakdown),
            result.status, result.price || null, Date.now(), Date.now()
          );
          console.log(`Найден: @${randomUsername} (${total} баллов)`);
        }
      }
    } catch (e) {
      console.error('Ошибка сканера:', e.message);
    }
  }, intervalMs);
}

module.exports = { startScanner };
