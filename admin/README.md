# Админ-панель KOSHEK JEWERLY

Веб-админ-панель для управления товарами в Google Sheets.

## Структура

- `backend/` - Express API сервер
- `frontend/` - React фронтенд

## Настройка

### 1. Backend

```bash
cd admin/backend
npm install
```

Создай файл `.env`:
```env
PORT=4001
JWT_SECRET=твой-длинный-случайный-секрет-для-jwt
GOOGLE_SHEET_ID=id_твоей_таблицы
GOOGLE_SA_FILE=../../backend/sa.json
SHEET_NAMES=ягоды,шея,руки,уши,сертификаты
ADMIN_USERNAME=admin
ADMIN_PASSWORD=твой_пароль
ADMIN_FRONTEND_URL=http://localhost:5174
```

### 2. Frontend

```bash
cd admin/frontend
npm install
```

Создай файл `.env`:
```env
VITE_API_URL=http://localhost:4001
```

### 3. Google Sheets - изменение прав

**Важно:** Нужно изменить права сервисного аккаунта с `readonly` на полный доступ.

1. Открой Google Sheets таблицу
2. Нажми "Настройки доступа" (Share)
3. Найди сервисный аккаунт (email вида `...@....iam.gserviceaccount.com`)
4. Измени права с "Читатель" (Viewer) на "Редактор" (Editor)
5. Сохрани

Или добавь сервисный аккаунт заново с правами "Редактор".

## Запуск

### Backend
```bash
cd admin/backend
npm run dev
```

### Frontend
```bash
cd admin/frontend
npm run dev
```

Открой http://localhost:5174

## Функционал (текущий)

- ✅ Авторизация через JWT
- ✅ Просмотр списка товаров
- ✅ Фильтрация по категориям
- ✅ Отображение активных/неактивных товаров

## TODO

- [ ] Добавление товаров
- [ ] Редактирование товаров
- [ ] Удаление товаров
- [ ] Загрузка фото на Uploadcare
- [ ] Изменение порядка товаров
- [ ] Генерация slug и артикула

