const { fullUsernameCheck } = require('./telegram');
const { evaluateUsername } = require('./scoring');

async function sendNtfy(topic, message) {
  try {
    await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: message });
  } catch (e) { console.error('ntfy error:', e.message); }
}

function startScanner({ intervalMs = 10000 } = {}) {
  console.log('Сканер запущен...');
  
  setInterval(async () => {
    try {
      const chars = 'abcdefghiklmnoprstuvwxy';
      const length = Math.random() > 0.5 ? 5 : 6;
      let randomUsername = '';
      for (let i = 0; i < length; i++) {
        randomUsername += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      
      const existing = global.db.prepare('SELECT id FROM found_usernames WHERE username = ?').get(randomUsername);
      if (existing) return; 
      
      const result = await fullUsernameCheck(randomUsername);
      
      if (result.status === 'free') {
        const { total, breakdown } = evaluateUsername(randomUsername);
        
        global.db.prepare(`
          INSERT INTO found_usernames 
          (username, length, score, score_breakdown, status, fragment_price, found_at, last_checked_at, is_hidden) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(randomUsername, randomUsername.length, total, JSON.stringify(breakdown), result.status, result.price || null, Date.now(), Date.now());
        
        if (total >= 60) sendNtfy('usolov', `Найден: @${randomUsername}\nScore: ${total}`);
        console.log(`Найден: @${randomUsername} (${total} баллов)`);
      }
    } catch (e) {
      console.error('Ошибка сканера:', e.message);
    }
  }, intervalMs);
}

module.exports = { startScanner };
