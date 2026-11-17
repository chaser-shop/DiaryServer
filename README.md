# НАВС — Електронний щоденник

Vite + React (фронтенд) і Vercel Serverless Functions + MongoDB (авторизація).
Спочатку екран входу, після входу — головна панель.

## Змінні середовища (Vercel → Settings → Environment Variables)

| Змінна | Опис |
| --- | --- |
| `MONGODB_URI` | рядок підключення MongoDB Atlas |
| `MONGODB_DB` | назва бази (необовʼязково, за замовчуванням `navs`) |
| `JWT_SECRET` | довгий випадковий рядок (`openssl rand -base64 48`) |

У MongoDB Atlas: Network Access → дозволити `0.0.0.0/0` (Vercel не має фіксованого IP).

## Деплой
1. Завантажити проєкт у GitHub-репозиторій, імпортувати в Vercel (Framework: Vite).
2. Додати змінні середовища, натиснути Deploy.

## Користувач
`admin` / `admin123` створюється автоматично при першому вході (колекція `users`).
Також: `npm run seed` (з `.env.local`). **Після першого запуску змініть пароль.**

## Локально
`npm i -g vercel && npm i && vercel dev` (потрібен `.env.local` за зразком `.env.example`).
Звичайний `npm run dev` показує лише фронтенд — `/api` працює тільки через `vercel dev` або на Vercel.
