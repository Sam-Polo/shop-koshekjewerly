#!/usr/bin/env bash
# Ежедневный бэкап критичных файлов бота.
# Запускается через cron: 0 3 * * * /opt/bot/scripts/backup.sh >> /opt/bot/backups/backup.log 2>&1
set -euo pipefail

BOT_DIR="/opt/bot/bot"
BACKUP_DIR="/opt/bot/backups"
RETAIN_DAYS=14
DATE=$(date +%Y-%m-%d)

mkdir -p "$BACKUP_DIR"

backed_up=0

if [ -f "$BOT_DIR/user-chat-ids.json" ]; then
  cp "$BOT_DIR/user-chat-ids.json" "$BACKUP_DIR/user-chat-ids-$DATE.json"
  backed_up=$((backed_up + 1))
fi

if [ -f "$BOT_DIR/failed-tg-notifications.json" ]; then
  cp "$BOT_DIR/failed-tg-notifications.json" "$BACKUP_DIR/failed-tg-notifications-$DATE.json"
  backed_up=$((backed_up + 1))
fi

# удаляем старые бэкапы — главная защита от переполнения диска
find "$BACKUP_DIR" -maxdepth 1 -name "*.json" -mtime +$RETAIN_DAYS -delete

# показываем что занято (удобно для мониторинга в логе)
used=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
count=$(find "$BACKUP_DIR" -maxdepth 1 -name "*.json" | wc -l)

echo "[$(date '+%Y-%m-%d %H:%M:%S')] backed up $backed_up file(s) | total in $BACKUP_DIR: $count files, $used"
