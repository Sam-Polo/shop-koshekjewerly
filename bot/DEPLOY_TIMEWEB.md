# Деплой бота на Timeweb VDS

## Шаг 1: Подключение к серверу

После создания VDS на Timeweb получишь:
- IP адрес
- Логин (обычно `root`)
- Пароль (или SSH ключ)

Подключись через SSH (в PowerShell на Windows):
```powershell
ssh root@ТВОЙ_IP_АДРЕС
```

## Шаг 2: Обновление системы

```bash
apt update && apt upgrade -y
```

## Шаг 3: Установка Node.js

Устанавливаем Node.js 20.x (LTS версия):

```bash
# добавляем репозиторий NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

# устанавливаем Node.js
apt install -y nodejs

# проверяем версию
node -v  # должно быть v20.x.x
npm -v
```

## Шаг 4: Установка PM2 (процесс-менеджер)

PM2 нужен для автозапуска бота и перезапуска при падении:

```bash
npm install -g pm2
```

## Шаг 5: Подготовка проекта

### 5.1 Клонируем репозиторий (или загружаем код)

```bash
# создаем директорию для проекта
mkdir -p /opt/bot
cd /opt/bot

# если используешь git:
git clone https://github.com/ТВОЙ_ЮЗЕРНЕЙМ/shop-koshekjewerly.git .
cd bot

# или загрузи файлы через SFTP/SCP
```

### 5.2 Устанавливаем зависимости

```bash
cd /opt/bot/bot
npm install --production
```

### 5.3 Создаем файл .env

```bash
nano .env
```

Добавь переменные окружения:
```env
TG_BOT_TOKEN=твой_токен_бота
TG_WEBAPP_URL=https://sam-polo.github.io/shop-koshekjewerly
BACKEND_URL=https://shop-koshekjewerly.onrender.com
SUPPORT_USERNAME=semyonp88
TG_MANAGER_CHAT_ID=твой_chat_id
```

Сохрани: `Ctrl+O`, `Enter`, `Ctrl+X`

## Шаг 6: Сборка проекта

```bash
npm run build
```

## Шаг 7: Запуск через PM2

### 7.1 Запускаем бота

```bash
pm2 start npm --name "telegram-bot" -- start
```

### 7.2 Сохраняем конфигурацию PM2 (для автозапуска после перезагрузки)

```bash
pm2 save
pm2 startup
```

Выполни команду, которую покажет `pm2 startup` (она будет начинаться с `sudo env PATH=...`).

### 7.3 Проверяем статус

```bash
pm2 status
pm2 logs telegram-bot
```

Если видишь логи бота - всё работает!

## Шаг 8: Полезные команды PM2

```bash
# просмотр логов
pm2 logs telegram-bot

# перезапуск бота
pm2 restart telegram-bot

# остановка бота
pm2 stop telegram-bot

# удаление из PM2
pm2 delete telegram-bot

# мониторинг ресурсов
pm2 monit
```

## Шаг 9: Обновление бота

Когда нужно обновить код:

```bash
cd /opt/bot/bot

# если используешь git:
git pull
cd bot

# или загрузи новые файлы через SFTP

# пересобираем и перезапускаем
npm install --production
npm run build
pm2 restart telegram-bot
```

## Шаг 10: Проверка работы

1. Напиши боту `/start` в Telegram
2. Проверь логи: `pm2 logs telegram-bot`
3. Должен быть лог keep-alive каждые 5 минут

## Troubleshooting

### Бот не запускается

```bash
# смотрим логи
pm2 logs telegram-bot --lines 50

# проверяем .env файл
cat .env

# проверяем сборку
ls -la dist/
```

### Бот падает

```bash
# смотрим детальные логи
pm2 logs telegram-bot --err

# проверяем переменные окружения
pm2 env telegram-bot
```

### Файл user-chat-ids.json не сохраняется

Проверь права доступа:
```bash
chmod 644 user-chat-ids.json
chown $USER:$USER user-chat-ids.json
```

## Безопасность

1. **Не храни .env в git** (уже в .gitignore)
2. **Используй SSH ключи** вместо паролей (опционально)
3. **Настрой firewall** если нужно (обычно Timeweb настраивает сам)

## Резервное копирование

Файл `user-chat-ids.json` хранится в `/opt/bot/bot/user-chat-ids.json`

Можно настроить автоматический бэкап через cron или использовать бэкапы Timeweb (90₽/мес).

