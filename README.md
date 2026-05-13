# igor-assistant

Персональный AI-ассистент в Телеграме для Игоря. Работает на Cloudflare Workers + D1 + Gemini 2.5 Flash.

## Что умеет

- Общается голосом/текстом/фото (Gemini поддерживает все модальности)
- Помнит тебя долгосрочно (личная инфа, предпочтения, факты, контекст)
- Ведёт цели (год/квартал/месяц/неделя) и прогресс
- Ставит напоминания с повторами (daily, weekly, weekdays)
- Трекает привычки с недельным стриком
- Логит тренировки и питание (считает калории/БЖУ сам по описанию)
- Утром 08:00 спрашивает план, вечером 22:00 — разбор дня
- Воскресенье 20:00 — недельное ревью по всей собранной статистике

## Стек

- **Cloudflare Workers** — хостинг (бесплатно, 100k req/день, always-on)
- **Cloudflare D1** — SQLite для всей памяти (бесплатно)
- **Cloudflare Cron Triggers** — каждую минуту для напоминаний и расписания
- **Google Gemini 2.5 Flash** — LLM с function calling + мультимодальность
- **TypeScript** — без внешних зависимостей на рантайме (только raw fetch)

## Разработка

```bash
npm install
# Локально (без D1 remote):
npm run dev
# Миграции:
npm run db:migrate:remote
# Деплой:
npm run deploy
```

## Секреты

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
```

## Подключение webhook

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://igor-assistant.<worker-subdomain>.workers.dev/webhook"
```

## Команды бота

- `/start`, `/help` — справка
- `/goals` — активные цели
- `/today` — что сегодня
- `/habits` — привычки со стриком
- `/reminders` — напоминания
- `/tz Europe/Moscow` — сменить таймзону
- `/clear` — стереть историю чата (память фактов остаётся)

Остальное — свободной речью: «напомни в 18 позвонить маме», «сделал жим лёжа 60кг 4х8», «съел овсянку 80г», «добавь привычку 10к шагов», «хочу к лету пробежать 5км за 25 минут».
