// Локальний запуск: npm start
require('dotenv').config();
const app = require('./lib/app');
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Щоденник: http://localhost:${port}`));
