// Нормалізація ПІБ: однакові людські варіанти написання дають один ключ.

function cleanName(raw) {
  return String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function validName(name) {
  if (name.length < 3 || name.length > 120) return false;
  if (name.split(' ').length < 2) return false;            // мінімум прізвище + ім'я
  return /^[\p{L}\p{M}'’ʼ`.\- ]+$/u.test(name);
}

function makeKey(name) {
  return cleanName(name)
    .toLocaleLowerCase('uk')
    .replace(/[’ʼ`]/g, "'");
}

module.exports = { cleanName, validName, makeKey };
