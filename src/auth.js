const jwt = require('jsonwebtoken');
const { User } = require('./models');

const bindDevice = process.env.BIND_DEVICE !== 'false';

function sign(user, deviceId) {
  return jwt.sign({ sub: String(user._id), dev: deviceId }, process.env.JWT_SECRET, { expiresIn: '180d' });
}

// Користувача щоразу читаємо з бази, тож зміна галочки isAdmin діє одразу.
async function auth(req, res, next) {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'Потрібен вхід' });

    let payload;
    try {
      payload = jwt.verify(m[1], process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Сеанс завершено, увійдіть знову' });
    }

    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Акаунт не знайдено' });
    if (bindDevice && user.deviceId !== payload.dev) {
      return res.status(401).json({ error: 'Сеанс завершено, увійдіть знову' });
    }

    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

function adminOnly(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Лише для адміністратора' });
  }
  next();
}

module.exports = { sign, auth, adminOnly, bindDevice };
