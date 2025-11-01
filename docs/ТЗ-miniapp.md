### ТЗ: Telegram Mini App «Магазин украшений» (Node.js)

— версия: 0.1 (MVP)  
— дата: 2025‑10‑30

#### цель
запустить мини‑приложение в telegram с каталогом ~50+ товаров, корзиной, чеком‑аутом, чатом с менеджером и «о нас». оплата отложена до решения заказчика.

#### стек
- frontend: react + typescript + telegram web apps sdk; vite/next.js (на выбор при старте репо)
- bot: node.js + telegraf или grammY
- backend/api: node.js (nestjs или express) + typescript
- db: postgres; хранение картинок — s3‑совместимое (на старте можно статикой)

#### функционал (mvp)
- каталог: разделы «ягоды (special)», «шея», «руки», «уши»; грид/лист по макету
- карточка товара: фото (1–5), название, цена (RUB), описание, наличие
- поиск по названию, сортировка по цене, фильтр по разделам
- корзина: добавить/удалить/изменить количество, подсчёт суммы
- оформление заказа: имя, телефон, tg username (из initData), адрес — опционально
- оплата: отложено (провайдер будет выбран позже), интерфейс провайдера заложить
- поддержка: кнопка → deep link в tg на @username менеджера (на тесте — @semyonp88)
- о нас: экран/модал с текстом, логотипом и ссылками
- рассылки: сбор user_id через бота, базовая массовая отправка (после mvp)

#### дизайн/ux
- шрифт: `fonts/Forum-Regular.ttf` (подключить и задать fallback: system-ui)
- логотип: `assets/logo.PNG`
- сетка/цвета/стили — по макетам из `design-model/` (точные размеры уточним при вёрстке)
- поддержка tg темы (светлая/тёмная) через themeParams, webapp mainButton/backButton

#### интеграция с google sheets (источник каталога)
- ссылка на таблицу: `https://docs.google.com/spreadsheets/d/1aqnsr0oseSfm5ZErHaz9sl_eUMdJQGpnERrdf3ztZvI/edit?usp=sharing`
- колонки (на старте):
  - id, slug, title, description, category, price_rub, images, active, stock
  - images: список url через запятую
- определения:
  - slug — человеко‑читаемый уникальный идентификатор товара в url/ссылках (латиница, дефисы), пример: `berry-bracelet-rose`.
  - variant_name — название параметра вариации (например, «размер», «цвет»).
  - variant_values — значения вариаций (например: `S,M,L` или `золото,серебро`).
  - примечание: для mvp вариации отключены; колонки для вариаций не добавляем. при необходимости добавим позже.
- доступ: таблица шарится на сервисный аккаунт google (email вида `…@….iam.gserviceaccount.com`) с правом чтения; ключи будут храниться в env бэкенда.
- синхронизация:
  - v1: ручной импорт (эндпоинт `/admin/import/sheets`), idempotent upsert по `id` или `slug`
  - v2: cron/очередь раз в 5–10 минут
  - валидация: обязательные поля `title`, `category`, `price_rub`, хотя бы одно изображение

#### backend/api
- сущности: users, products, categories, orders, order_items, payments (заглушка), promos (зарезервировано)
- авторизация: проверка подписи `initData` от telegram (без логина/пароля)
- эндпоинты (черновик):
  - GET `/api/products` — список, фильтры: category, q, sort
  - GET `/api/products/:slug` — карточка товара
  - POST `/api/cart/validate` — пересчёт корзины/цен
  - POST `/api/orders` — создание заказа (status=new/awaiting_payment)
  - POST `/api/payments/:orderId/create` — создать платёж (интерфейс провайдера, без интеграции пока)
  - POST `/webhooks/payment/:provider` — вебхук оплаты (позже)
  - POST `/admin/import/sheets` — импорт каталога из gsheet (с ключом)
- платежи: спроектировать интерфейс `PaymentProvider` (createPayment, parseWebhook, verifySignature), реализации добавить после выбора провайдера
- логирование: pino; валидация схем: zod/class-validator; идемпотентность на вебхуках (позже)

#### bot
- команды: `/start` (deep link в мини‑апп), `/support` (контакт менеджера)
- менеджер для тестов: `@semyonp88` (заменить на финальный @username при готовности)
- сбор user_id и согласия на рассылку (опционально)
- рассылка: базовый сценарий после mvp

#### данные/модели (черновик)
- Product: id, slug, title, description, price_rub, currency=RUB, category, images[], active, stock, createdAt
- Order: id, userId, items[], amount, deliveryType?, address?, phone, status, createdAt
- Payment: id, orderId, provider?, externalId?, status?, payload?, createdAt (заглушка до выбора провайдера)
- User: id, tgUserId, username, consentMarketing?, createdAt

#### инфраструктура/деплой
- фронт (static) — vercel/netlify или российский хостинг (selectel/vk cloud)
- бэк/бот — railway/render/fly.io/селектел; учесть доступность из рф
- env: TG_BOT_TOKEN, TG_WEBAPP_URL, DB_URL, GOOGLE_SA_JSON, IMPORT_SHEET_ID, ADMIN_IMPORT_KEY, PAYMENT_PROVIDER=none

#### приёмка mvp
- каталог рендерится по макету, шрифт Forum подключён, разделы/поиск/фильтр работают
- корзина и оформление заказа до шага «оплата» включительно; оплата отключена, показ заглушки
- чат с менеджером открывает диалог по кнопке, «о нас» отображается
- импорт из google sheets создаёт/обновляет товары

#### открытые вопросы
- замена тестового @username менеджера `@semyonp88` на финальный
- финальный выбор платёжного провайдера (robokassa/yookassa) и условия
- доставка: способы/стоимость/города; нужны ли вариации (размер/цвет)

#### что нужно от заказчика/владельца
- дать доступ таблицы на сервисный аккаунт google (email сервисного аккаунта будет предоставлен при настройке окружения)
- подтверждение макетов (размеры, отступы, состояния кнопок)
- контент для «о нас» (текст/фото/ссылки)


