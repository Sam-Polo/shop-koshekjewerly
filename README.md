### магазин украшений — telegram mini app (node.js)

структура:

```
frontend/  — react + vite + ts (mini app ui)
backend/   — express + ts (api, импорт из google sheets)
bot/       — grammY (бот: /start, /support, deep-link в mini app)
docs/      — ТЗ и документация
assets/, fonts/, design-model/ — медиа и макеты
```

быстрый старт (общее):
- установить node 18+
- в каждом сервисе скопировать `.env.example` → `.env` и заполнить
- запустить `npm i` и `npm run dev` в соответствующей папке

переменные окружения в соответствующих `.env.example` в `frontend/`, `backend/`, `bot/`.


