# Деплой бота на Timeweb VDS

## Шаг 1: Подключение к серверу

После создания VDS на Timeweb получишь:
- IP адрес (IPv4 или IPv6)
- Логин (обычно `root`)
- Пароль (или SSH ключ)

Подключись через SSH (в PowerShell на Windows):

**Если у тебя IPv4 адрес (например: `185.123.45.67`):**
```powershell
ssh root@185.247.185.14
d^myHBkKmb?25d
```

**Если у тебя IPv6 адрес (например: `2a03:6f01:1:2::1`):**
```powershell
ssh root@[2a03:6f01:1:2::1]
```
⚠️ **Важно:** IPv6 адрес нужно обернуть в квадратные скобки `[]`

После выполнения команды тебя попросят ввести пароль (или подтвердить подключение по SSH ключу).

**Если не работает:**
1. Проверь что у тебя правильный IP адрес (в панели Timeweb)
2. Попробуй использовать IPv4 адрес вместо IPv6 (если есть оба)
3. Убедись что порт 22 открыт (обычно открыт по умолчанию)

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
git clone https://github.com/Sam-Polo/shop-koshekjewerly.git .
cd bot

# или загрузи файлы через SFTP/SCP
```

### 5.2 Устанавливаем зависимости

```bash
cd /opt/bot/bot
# устанавливаем все зависимости (включая devDependencies для сборки)
npm install
```

**Важно:** Используем `npm install` (без `--production`), потому что для сборки нужны devDependencies (TypeScript, tsx и т.д.)

### 5.3 Создаем файл .env

```bash
nano .env
```

Добавь переменные окружения:
```env
TG_BOT_TOKEN=твой_токен_бота
TG_WEBAPP_URL=https://sam-polo.github.io/shop-koshekjewerly
BACKEND_URL=https://shop-koshekjewerly.onrender.com
SUPPORT_USERNAME=koshekmanager
TG_MANAGER_CHAT_ID=1891821933
```

**Как получить TG_MANAGER_CHAT_ID:**
1. Напиши боту @userinfobot в Telegram
2. Бот покажет твой ID (число, например: `8495144404`)
3. Это и есть твой `chat_id` - скопируй его

**Или альтернативный способ:**
- Напиши своему боту `/start`
- Посмотри логи бота - там будет `chat_id` пользователя

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

**Важно:** В новых версиях PM2 автозапуск настраивается автоматически. Если видишь сообщение `[PM2] [v] Command successfully executed.` - всё готово, ничего дополнительно выполнять не нужно.

Если PM2 попросит выполнить команду с `sudo env PATH=...` - выполни её (в старых версиях PM2 это требуется).

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

