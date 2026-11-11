function evaluateUsername(username) {
  const uname = username.toLowerCase();
  const length = uname.length;
  let total = 0;
  const breakdown = {};

  if (length === 5) { total += 30; breakdown['Длина (5)'] = 30; }
  else if (length === 6) { total += 20; breakdown['Длина (6)'] = 20; }
  else { total += 5; breakdown['Длина (другая)'] = 5; }

  if (uname === uname.split('').reverse().join('')) {
    total += 30;
    breakdown['Палиндром'] = 30;
  }

  if (/(.)\1/.test(uname)) {
    total += 15;
    breakdown['Двойные буквы'] = 15;
  }

  if (/[aeiouy]$/.test(uname)) {
    total += 10;
    breakdown['Гласная в конце'] = 10;
  }

  const vowels = (uname.match(/[aeiouy]/g) || []).length;
  if (vowels < 2) {
    total -= 20;
    breakdown['Мало гласных'] = -20;
  }

  return { total: Math.max(0, Math.min(100, total)), breakdown };
}

module.exports = { evaluateUsername };
