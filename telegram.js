// telegram.js — проверка занятости юзернейма в Telegram + статус на Fragment

const BOT_TOKEN = process.env.BOT_TOKEN; // токен бота, создаётся через @BotFather
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/; // правила Telegram для юзернеймов

function isValidFormat(username) {
  return USERNAME_RE.test(username);
}

/**
 * Проверяет через Bot API, существует ли чат с таким юзернеймом.
 * Если Telegram возвращает "chat not found" — юзернейм свободен.
 */
async function checkTelegramAvailability(username) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=@${username}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.ok) {
    return { available: false, reason: 'taken' };
  }

  // Telegram возвращает ошибку и для "не найден", и для других случаев —
