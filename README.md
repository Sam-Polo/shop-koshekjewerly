# KOSHEK JEWERLY — Telegram Mini App

Магазин украшений в виде Telegram Mini App с интеграцией Google Sheets для управления каталогом.

## Технологии

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Express + TypeScript
- **Bot**: GrammY (Telegram Bot Framework)
- **Платежи**: Robokassa
- **Каталог**: Google Sheets API

## Структура проекта

```
frontend/  — React приложение (Telegram Mini App UI)
backend/   — Express API (импорт из Google Sheets, обработка заказов)
bot/       — Telegram бот (команды, рассылка, deep-links)
```

## Основной функционал

- Каталог товаров с категориями (Ягоды, Шея, Руки, Уши, Сертификаты)
- Корзина и оформление заказа
- Интеграция с Robokassa для оплаты
- Автоматический импорт товаров из Google Sheets
- Рассылка сообщений через бота (для менеджера)
- Управление остатками товаров (stock)

## Быстрый старт

1. Установи Node.js 18+
2. В каждой директории (`frontend/`, `backend/`, `bot/`) создай `.env` файл
3. Запусти `npm install` и `npm run dev` в нужной директории

Переменные окружения настраиваются через `.env` файлы в каждой директории.
