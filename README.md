# Telegram Mini App

Магазин украшений в виде Telegram Mini App с интеграцией Google Sheets для управления каталогом.

## Технологии

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Express + TypeScript
- **Bot**: GrammY
- **Платежи**: Robokassa
- **Каталог**: Google Sheets API

## Структура проекта

```
frontend/  — React приложение: Telegram Mini App UI
backend/   — Express API (импорт из Google Sheets, обработка заказов)
bot/       — Telegram бот
```

## Основной функционал

- Каталог товаров с категориями
- Корзина и оформление заказа
- Интеграция с Robokassa для оплаты
- Автоматический импорт товаров из Google Sheets
- Рассылка сообщений через бота
- Управление остатками товаров
