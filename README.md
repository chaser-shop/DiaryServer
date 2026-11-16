# Електронний щоденник НАВС: Vercel + MongoDB Atlas

## 1. MongoDB Atlas
1. Створіть безкоштовний кластер на mongodb.com/atlas.
2. Database Access: створіть користувача з паролем.
3. Network Access: додайте `0.0.0.0/0` (Vercel не має постійних IP-адрес).
4. Connect → Drivers: скопіюйте рядок `mongodb+srv://...` і підставте свій пароль.

## 2. Vercel
1. Завантажте цю папку в репозиторій GitHub (`.env` не додається, він у `.gitignore`).
2. vercel.com → Add New → Project → оберіть репозиторій. Framework Preset: Other. Build Command не потрібен.
3. Перед Deploy додайте змінні (Environment Variables): `MONGODB_URI`, `JWT_SECRET`, `ADMIN_PASSWORD`; за потреби `ADMIN_LOGIN`, `DB_NAME`.
4. Deploy. Відкрийте адресу проєкту й увійдіть як адміністратор (`admin` / ваш `ADMIN_PASSWORD`).

Через CLI: `npm i -g vercel`, у цій папці `vercel`, далі `vercel env add MONGODB_URI` (так само для інших змінних) і `vercel --prod`.

Перший запит створює адміністратора. Курсантів додайте в панелі адміністратора.
Якщо внизу панелі написано «демонстраційний режим», сервер не бачить MongoDB: перевірте змінні та Network Access.

## Локально
`npm install`, `.env` за зразком `.env.example`, `npm start`, http://localhost:3000
