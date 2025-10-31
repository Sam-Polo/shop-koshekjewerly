переменные окружения (backend)

обязательные:
- PORT — порт api (по умолчанию 4000)
- IMPORT_SHEET_ID — id google sheet (без /edit?..)
- GOOGLE_SA_JSON — json сервисного аккаунта (одной строкой)
- ADMIN_IMPORT_KEY — ключ для ручного импорта
- TG_WEBAPP_URL — url фронтенда (для cors)

опциональные:
- TG_BOT_TOKEN — токен бота (для валидаций/связки позже)
- DB_URL — postgres url (на mvp можно без бд)

пример команды импорта (локально):

curl -X POST "http://localhost:4000/admin/import/sheets" \
  -H "x-admin-key: $ADMIN_IMPORT_KEY"


