const { fullUsernameCheck } = require('./telegram');
const { evaluateUsername } = require('./scoring');

const WORDS = ['danya', 'alex', 'boss', 'money', 'crypto', 'magic', 'storm', 'king', 'queen', 'code', 'tech', 'wolf', 'top'];

async function sendNtfy(topic, message) {
  try {
    await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: message });
  } catch (e) { console.error('ntfy error:', e.message); }
}

function startScanner({ intervalMs = 10000 } = {}) {
  console.log('Сканер запущен...');
  
  setInterval(async () => {
    try {
      const baseWord = WORDS[Math.floor(Math.random() * WORDS.length)];
      const suffix = Math.random() > 0.7 ? Math.floor(Math.random() * 99) : '';
      const randomUsername = baseWord + suffix;
      
      const existing = global.db.prepare('SELECT id FROM found_usernames WHERE username = ?').get(randomUsername);
      if (existing) return; 
      
      const result = await fullUsernameCheck(randomUsername);
      
      if (result.status === 'free' || result.status === 'fragment_sale') {
        const { total, breakdown } = evaluateUsername(randomUsername);
        
        global.db.prepare(`
          INSERT INTO found_usernames 
          (username, length, score, score_breakdown, status, fragment_price, found_at, last_checked_at, is_hidden) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(randomUsername, randomUsername.length, total, JSON.stringify(breakdown), result.status, result.price || null, Date.now(), Date.now());
        
        sendNtfy('usolov', `Найден: @${randomUsername}\nScore: ${total}\nСтатус: ${result.status}`);

        console.log(`Найден: @${randomUsername} (${total} баллов)`);
      }
    } catch (e) {
      console.error('Ошибка сканера:', e.message);
    }
  }, intervalMs);
}

module.exports = { startScanner };
