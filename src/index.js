require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const routes = require('./routes');

const { MONGODB_URI, JWT_SECRET, PORT = 3000 } = process.env;
if (!MONGODB_URI) {
  console.error('Не задано MONGODB_URI (див. .env.example)');
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('Не задано JWT_SECRET (мінімум 16 символів, див. .env.example)');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

app.use(express.json({ limit: '2mb' }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', routes);

app.use((req, res) => res.status(404).json({ error: 'Не знайдено' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний запит' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

mongoose.connect(MONGODB_URI)
  .then(() => {
    app.listen(PORT, () => console.log(`Сервер щоденника: порт ${PORT}`));
  })
  .catch((e) => {
    console.error('Не вдалося підключитися до MongoDB:', e.message);
    process.exit(1);
  });
