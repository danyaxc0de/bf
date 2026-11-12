const BOT_TOKEN = process.env.BOT_TOKEN;
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;

function isValidFormat(username) {
  return USERNAME_RE.test(username);
}

async function checkTelegramAvailability(username) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=@${username}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.ok) {
    return { available: false, reason: 'taken' };
  }
