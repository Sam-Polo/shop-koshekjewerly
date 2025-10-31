запуск backend

1) `npm i`
2) выставь env (см. `ENV_VARS.md`)
3) `npm run dev`

эндпоинты:
- GET `/health` — проверка
- GET `/api/products` — список товаров (пусто до импорта)
- POST `/admin/import/sheets` — заглушка импорта (заголовок `x-admin-key`)


