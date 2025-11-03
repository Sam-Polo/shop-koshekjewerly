import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { fetchProductsFromSheet } from './sheets.js';
import { listProducts, upsertProducts } from './store.js';

const logger = pino();
const app = express();

// автоматический импорт товаров из google sheets
async function importProducts() {
  const sheetId = process.env.IMPORT_SHEET_ID;
  if (!sheetId) {
    logger.warn('IMPORT_SHEET_ID не задан, импорт пропущен');
    return;
  }
  try {
    logger.info('импорт товаров из google sheets...');
    const rows = await fetchProductsFromSheet(sheetId);
    upsertProducts(rows);
    logger.info({ imported: rows.length }, 'товары импортированы');
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка импорта товаров');
  }
}

app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.TG_WEBAPP_URL ?? true }));

// health
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// products
app.get('/api/products', (_req, res) => {
  const items = listProducts().filter(p => p.active)
  res.json({ items, total: items.length });
});

// отправка сообщения через Telegram Bot API
async function sendTelegramMessage(chatId: string | number, text: string) {
  const token = process.env.TG_BOT_TOKEN
  if (!token) {
    logger.warn('TG_BOT_TOKEN не задан, сообщение не отправлено')
    return false
  }
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      })
    })
    
    if (!response.ok) {
      const error = await response.text()
      logger.error({ error }, 'ошибка отправки сообщения в telegram')
      return false
    }
    
    return true
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка отправки сообщения в telegram')
    return false
  }
}

// извлекаем chat_id из initData (упрощенная версия без проверки подписи для MVP)
function extractChatIdFromInitData(initData: string): string | null {
  if (!initData) return null
  
  try {
    // парсим initData и ищем user
    const params = new URLSearchParams(initData)
    const userParam = params.get('user')
    if (userParam) {
      const user = JSON.parse(userParam)
      return user.id?.toString() || null
    }
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'не удалось извлечь chat_id из initData')
  }
  
  return null
}

// оформление заказа
app.post('/api/orders', async (req, res) => {
  try {
    const orderData = req.body
    const orderId = `ORD-${Date.now()}`
    
    // формируем сообщение для покупателя
    const itemsText = orderData.items.map((item: any) => 
      `• ${item.title} × ${item.quantity} — ${item.price * item.quantity} ₽`
    ).join('\n')
    
    const customerMessage = `
🎉 <b>Ваш заказ оформлен!</b>

Номер заказа: <code>${orderId}</code>

Товары:
${itemsText}

Доставка: ${orderData.deliveryCost} ₽
Итого: ${orderData.total} ₽

${orderData.deliveryRegion === 'europe' ? '📍 Адрес доставки:' : '📍 Пункт СДЭК:'}
${orderData.address}

💬 Для связи: @${(process.env.SUPPORT_USERNAME || 'semyonp88').replace('@', '')}
    `.trim()
    
    // формируем сообщение для менеджера
    const managerMessage = `
🛒 <b>Новый заказ!</b>

Номер: <code>${orderId}</code>
Покупатель: ${orderData.fullName}
Телефон: ${orderData.phone}
TG: ${orderData.username || 'не указан'}

${orderData.deliveryRegion === 'europe' ? '📍 Адрес доставки:' : '📍 Пункт СДЭК:'}
${orderData.country}, ${orderData.city}
${orderData.address}

Товары:
${itemsText}

Доставка: ${orderData.deliveryCost} ₽ (${orderData.deliveryRegion})
Итого: ${orderData.total} ₽

${orderData.comments ? `Комментарии: ${orderData.comments}` : ''}
    `.trim()
    
    // получаем chat_id покупателя из initData
    const customerChatId = orderData.initData ? extractChatIdFromInitData(orderData.initData) : null
    
    // получаем username менеджера из env
    const managerUsername = (process.env.SUPPORT_USERNAME || 'semyonp88').replace('@', '')
    
    // отправляем покупателю если есть chat_id
    if (customerChatId) {
      await sendTelegramMessage(customerChatId, customerMessage)
    } else {
      logger.warn('chat_id покупателя не найден, сообщение покупателю не отправлено')
    }
    
    // отправляем менеджеру по username
    // важно: менеджер должен начать диалог с ботом (написать /start), иначе отправка по username не сработает
    const managerSent = await sendTelegramMessage(`@${managerUsername}`, managerMessage)
    if (!managerSent) {
      logger.warn(`не удалось отправить сообщение менеджеру @${managerUsername}. Менеджер должен начать диалог с ботом (/start)`)
    }
    
    logger.info({ orderId }, 'заказ оформлен')
    
    res.json({ 
      ok: true, 
      orderId 
    })
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка оформления заказа')
    res.status(500).json({ error: e?.message || 'order_failed' })
  }
});

// ручной импорт (для тестов или форс-обновления)
app.post('/admin/import/sheets', async (req, res) => {
  const key = req.header('x-admin-key');
  if (!key || key !== process.env.ADMIN_IMPORT_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await importProducts();
    const count = listProducts().length;
    res.json({ ok: true, total: count });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'import_failed' });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, async () => {
  logger.info({ port }, 'backend started');
  
  // проверяем наличие TG_BOT_TOKEN
  if (!process.env.TG_BOT_TOKEN) {
    logger.warn('⚠️  TG_BOT_TOKEN не задан! Сообщения о заказах не будут отправляться.');
    logger.warn('Добавь переменную TG_BOT_TOKEN в Environment Variables на Render');
  } else {
    logger.info('TG_BOT_TOKEN настроен, отправка сообщений доступна');
  }
  
  // проверяем SUPPORT_USERNAME
  const supportUsername = process.env.SUPPORT_USERNAME || 'semyonp88'
  logger.info({ supportUsername: supportUsername.replace('@', '') }, 'SUPPORT_USERNAME настроен');
  logger.info('⚠️  Убедись что менеджер начал диалог с ботом (/start), иначе сообщения не дойдут');
  
  // импорт при запуске
  await importProducts();
  
  // периодический импорт (по умолчанию каждые 10 минут)
  const intervalMinutes = Number(process.env.IMPORT_INTERVAL_MINUTES ?? 10);
  if (intervalMinutes > 0) {
    setInterval(() => {
      importProducts();
    }, intervalMinutes * 60 * 1000);
    logger.info({ intervalMinutes }, 'периодический импорт настроен');
  }
});


