# KOSHEK — Telegram/MAX Mini App

Магазин украшений ручной работы в виде мини-приложения для Telegram и MAX.
Каталог и заказы управляются через Google Sheets, оплата — Robokassa,
доставка — СДЭК (Россия/СНГ) и EMS Почта России (международная), CRM — amoCRM.

## Структура проекта

```
frontend/  — мини-апп (React + Vite + TypeScript), один билд для Telegram и MAX
backend/   — Express API: каталог, заказы, оплата, доставка, CRM, уведомления
bot/       — Telegram-бот (grammY): вход в мини-апп, команды менеджера
max-bot/   — бот мессенджера MAX
admin/     — веб-админка (Express + JWT / React): товары, заказы, статистика
encoder/   — serverless FFmpeg-конвертер видео товаров
```

## Технологии

- **Frontend**: React + TypeScript + Vite, Swiper, framer-motion
- **Backend**: Node.js + Express + TypeScript, vitest
- **Боты**: grammY (Telegram), @maxhub/max-bot-api (MAX)
- **Данные**: Google Sheets API (каталог, заказы, настройки)
- **Платежи**: Robokassa (с фискализацией 54-ФЗ и BNPL)
- **Доставка**: CDEK API v2, Почта России «Отправка» (EMS)
- **CRM**: amoCRM
- **Медиа**: S3-совместимое хранилище + FFmpeg-конвертация видео

## Основной функционал

- Каталог с категориями, фото/видео галереями и конструктором украшений
- Корзина, промокоды (включая подарочные сертификаты), приоритетные заказы
- Оформление и оплата заказа с автосозданием отправления и отправкой трека покупателю
- Уведомления менеджеру в канал, лиды в amoCRM, учёт отгрузок
- Рассылки и посты в канал через бота
- Управление остатками через Google Sheets

Деплой — GitHub Actions (см. `.github/workflows/`).
