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

  const desc = (data.description || '').toLowerCase();
  if (desc.includes('chat not found')) {
    return { available: true };
  }

  return { available: null, reason: desc || 'unknown_error' };
}

async function checkFragmentStatus(username) {
  try {
    const res = await fetch(`https://fragment.com/username/${username}`);
    if (res.status === 404) {
      return { status: 'none' };
    }
    const html = await res.text();
    const priceMatch = html.match(/(\d[\d,]*)\s*TON/i);
    const isForSale = /Make offer|Buy now|status.*sale/i.test(html);

    if (isForSale && priceMatch) {
      return { status: 'fragment_sale', price: priceMatch[1] };
    }
    if (/Not for sale|unavailable/i.test(html)) {
      return { status: 'fragment_locked' };
    }
    return { status: 'none' };
  } catch (e) {
    return { status: 'unknown', error: e.message };
  }
}

async function fullUsernameCheck(username) {
  if (!isValidFormat(username)) {
    return { username, status: 'invalid_format' };
  }

  const tg = await checkTelegramAvailability(username);

  if (tg.available === false) {
    return { username, status: 'taken' };
  }
  if (tg.available === null) {
    return { username, status: 'check_failed', reason: tg.reason };
  }

  const fragment = await checkFragmentStatus(username);

  if (fragment.status === 'fragment_sale') {
    return { username, status: 'fragment_sale', price: fragment.price };
  }
  if (fragment.status === 'fragment_locked') {
    return { username, status: 'fragment_locked' };
  }

  return { username, status: 'free' };
}

module.exports = { isValidFormat, checkTelegramAvailability, checkFragmentStatus, fullUsernameCheck };
