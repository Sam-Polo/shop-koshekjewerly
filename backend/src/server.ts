import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { fetchProductsFromSheet } from './sheets.js';
import { listProducts, upsertProducts, decreaseProductStock } from './store.js';
import { createOrder, getOrder, updateOrderStatus, type OrderStatus } from './orders.js';
import { generatePaymentUrl, verifyResultSignature } from './robokassa.js';

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

// настройка CORS - проверяем что TG_WEBAPP_URL задан
const webappOrigin = process.env.TG_WEBAPP_URL
if (!webappOrigin) {
  logger.warn('⚠️  TG_WEBAPP_URL не задан! CORS может не работать корректно.')
}
app.use(cors({ 
  origin: webappOrigin || false, // если не задан, запрещаем все источники
  credentials: true
}));

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

// отправка уведомлений о заказе (вызывается после успешной оплаты)
async function sendOrderNotifications(order: any) {
  const itemsText = order.orderData.items.map((item: any) => 
    `• ${item.title} × ${item.quantity} — ${item.price * item.quantity} ₽`
  ).join('\n')
  
  const customerMessage = `
🎉 <b>Ваш заказ оформлен!</b>

Номер заказа: <code>${order.orderId}</code>

Товары:
${itemsText}

Доставка: ${order.orderData.deliveryCost} ₽
Итого: ${order.orderData.total} ₽

${order.orderData.deliveryRegion === 'europe' ? '📍 Адрес доставки:' : '📍 Пункт СДЭК:'}
${order.orderData.address}

Ваш заказ будет отправлен в течении 3-5 дней, мы пришлем уведомление с трек номером для отслеживания. Благодарим за заказ 🤍

💬 Для связи: @${(process.env.SUPPORT_USERNAME || 'semyonp88').replace('@', '')}
  `.trim()
  
  const managerMessage = `
🛒 <b>Новый заказ!</b>

Номер: <code>${order.orderId}</code>
Покупатель: ${order.orderData.fullName}
Телефон: ${order.orderData.phone}
TG: ${order.orderData.username || 'не указан'}

${order.orderData.deliveryRegion === 'europe' ? '📍 Адрес доставки:' : '📍 Пункт СДЭК:'}
${order.orderData.country}, ${order.orderData.city}
${order.orderData.address}

Товары:
${itemsText}

Доставка: ${order.orderData.deliveryCost} ₽ (${order.orderData.deliveryRegion})
Итого: ${order.orderData.total} ₽

${order.orderData.comments ? `Комментарии: ${order.orderData.comments}` : ''}
  `.trim()
  
  // отправляем покупателю если есть chat_id
  if (order.customerChatId) {
    await sendTelegramMessage(order.customerChatId, customerMessage)
  } else {
    logger.warn('chat_id покупателя не найден, сообщение покупателю не отправлено')
  }
  
  // отправляем менеджеру
  const managerChatId = process.env.TG_MANAGER_CHAT_ID
  if (managerChatId) {
    if (order.customerChatId !== managerChatId) {
      await sendTelegramMessage(managerChatId, managerMessage)
    } else {
      await sendTelegramMessage(managerChatId, managerMessage)
      logger.info('покупатель является менеджером, отправлено второе сообщение')
    }
  } else {
    logger.warn(`TG_MANAGER_CHAT_ID не задан, сообщение менеджеру не отправлено`)
  }
}

// оформление заказа (создаем заказ и возвращаем URL для оплаты)
app.post('/api/orders', async (req, res) => {
  try {
    const orderData = req.body
    
    // валидация входных данных
    if (!orderData.items || !Array.isArray(orderData.items) || orderData.items.length === 0) {
      return res.status(400).json({ error: 'invalid_items' })
    }
    
    // пересчитываем цены на бэкенде из актуальных данных товаров (защита от подмены цен)
    const products = listProducts()
    const validatedItems = orderData.items.map((item: any) => {
      const product = products.find(p => p.slug === item.slug && p.active)
      if (!product) {
        throw new Error(`Товар ${item.slug} не найден или неактивен`)
      }
      
      // используем актуальную цену и название с бэкенда, игнорируем данные от клиента
      return {
        slug: product.slug,
        title: product.title,
        price: product.price_rub, // актуальная цена с бэкенда
        quantity: Math.max(1, Math.floor(item.quantity || 1)) // валидация количества
      }
    })
    
    // проверяем что все товары найдены
    if (validatedItems.length !== orderData.items.length) {
      return res.status(400).json({ error: 'some_items_not_found' })
    }
    
    // пересчитываем сумму товаров на бэкенде
    const itemsTotal = validatedItems.reduce((sum: number, item: any) => {
      return sum + (item.price * item.quantity)
    }, 0)
    
    // валидация стоимости доставки
    const deliveryCost = typeof orderData.deliveryCost === 'number' && orderData.deliveryCost >= 0 
      ? orderData.deliveryCost 
      : 0
    
    // пересчитываем итоговую сумму на бэкенде
    const total = itemsTotal + deliveryCost
    
    // Робокасса требует числовой InvId, используем timestamp
    // но сохраняем префикс для внутреннего использования
    const timestamp = Date.now()
    const orderId = `ORD-${timestamp}`
    const invoiceId = String(timestamp) // числовой ID для Робокассы
    
    // получаем chat_id покупателя из initData
    const customerChatId = orderData.initData ? extractChatIdFromInitData(orderData.initData) : null
    
    // создаем заказ со статусом pending (используем пересчитанные данные)
    const order = createOrder(orderId, {
      items: validatedItems, // используем валидированные товары с актуальными ценами
      fullName: orderData.fullName || '',
      phone: orderData.phone || '',
      username: orderData.username,
      country: orderData.country || '',
      city: orderData.city || '',
      address: orderData.address || '',
      deliveryRegion: orderData.deliveryRegion || '',
      deliveryCost: deliveryCost,
      total: total, // пересчитанная сумма на бэкенде
      comments: orderData.comments
    }, customerChatId)
    
    logger.info({ 
      orderId, 
      itemsCount: validatedItems.length,
      itemsTotal,
      deliveryCost,
      total,
      clientTotal: orderData.total // логируем что прислал клиент для сравнения
    }, 'заказ создан с пересчитанными ценами на бэкенде, ожидает оплаты')
    
    // генерируем URL для оплаты
    const webappUrl = process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly'
    
    // проверяем наличие обязательных переменных для Робокассы
    if (!process.env.ROBOKASSA_MERCHANT_LOGIN || !process.env.ROBOKASSA_PASSWORD_1) {
      logger.error('ROBOKASSA_MERCHANT_LOGIN или ROBOKASSA_PASSWORD_1 не заданы')
      return res.status(500).json({ error: 'payment_config_error' })
    }
    
    const paymentUrl = generatePaymentUrl({
      orderId, // внутренний ID для логирования
      invoiceId, // числовой ID для Робокассы
      amount: total, // используем пересчитанную сумму, а не от клиента
      description: `Заказ ${orderId}`,
      successUrl: `${webappUrl}/payment/success`,
      failUrl: `${webappUrl}/payment/fail`
    })
    
    // логируем сгенерированный URL для отладки (без паролей)
    logger.info({ 
      orderId,
      invoiceId, // числовой ID для Робокассы
      amount: total, // пересчитанная сумма
      merchantLogin: process.env.ROBOKASSA_MERCHANT_LOGIN,
      isTest: process.env.ROBOKASSA_TEST,
      paymentUrlLength: paymentUrl.length
    }, 'URL для оплаты сгенерирован')
    
    res.json({ 
      ok: true, 
      orderId,
      paymentUrl // URL для редиректа на оплату
    })
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка создания заказа')
    res.status(500).json({ error: e?.message || 'order_failed' })
  }
});

// callback от Робокассы при успешной оплате (Result URL)
app.post('/api/robokassa/result', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { OutSum, InvId, SignatureValue, ...additionalParams } = req.body
    
    logger.info({ OutSum, InvId, SignatureValue }, 'получен callback от Робокассы')
    
    // проверяем подпись
    const isValid = verifyResultSignature({
      outSum: OutSum,
      invoiceId: InvId,
      signature: SignatureValue,
      additionalParams
    })
    
    if (!isValid) {
      logger.error({ InvId }, 'неверная подпись от Робокассы')
      return res.status(400).send('ERROR')
    }
    
    // находим заказ по invoiceId (преобразуем в orderId)
    // Робокасса возвращает числовой InvId, а у нас заказ хранится по orderId (ORD-timestamp)
    const orderId = `ORD-${InvId}`
    const order = getOrder(orderId)
    if (!order) {
      logger.error({ InvId, orderId }, 'заказ не найден')
      return res.status(404).send('ERROR')
    }
    
    // проверяем формат InvId (должен быть числом)
    const invoiceIdNum = parseInt(InvId, 10)
    if (isNaN(invoiceIdNum) || invoiceIdNum <= 0) {
      logger.error({ InvId }, 'невалидный формат InvId от Робокассы')
      return res.status(400).send('ERROR')
    }
    
    // обновляем статус на оплачен
    if (order.status === 'pending') {
      // проверяем что сумма от Робокассы совпадает с суммой заказа (защита от подмены)
      const robokassaAmount = parseFloat(OutSum)
      const orderAmount = order.orderData.total
      
      // сравниваем с точностью до копеек (0.01)
      if (Math.abs(robokassaAmount - orderAmount) > 0.01) {
        logger.error({ 
          InvId, 
          orderId,
          robokassaAmount, 
          orderAmount, 
          difference: Math.abs(robokassaAmount - orderAmount)
        }, 'сумма от Робокассы не совпадает с суммой заказа')
        return res.status(400).send('ERROR')
      }
      
      updateOrderStatus(orderId, 'paid')
      
      // уменьшаем stock товаров после успешной оплаты
      for (const item of order.orderData.items) {
        const success = decreaseProductStock(item.slug, item.quantity)
        if (!success) {
          logger.warn({ slug: item.slug, quantity: item.quantity }, 'не удалось уменьшить stock товара (возможно stock undefined или недостаточно)')
        } else {
          logger.info({ slug: item.slug, quantity: item.quantity }, 'stock товара уменьшен в памяти')
        }
      }
      
      // отправляем уведомления
      await sendOrderNotifications(order)
      
      logger.info({ InvId, orderId, amount: robokassaAmount }, 'заказ оплачен, сумма проверена, уведомления отправлены')
    }
    
    // Робокасса ожидает ответ "OK<InvId>"
    res.send(`OK${InvId}`)
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка обработки callback от Робокассы')
    res.status(500).send('ERROR')
  }
});

// обработчик для Success URL (поддерживает GET и POST)
const handleSuccessUrl = (req: express.Request, res: express.Response) => {
  // получаем InvId из query (GET) или body (POST)
  const InvId = req.query.InvId || req.body?.InvId
  const botUsername = process.env.TG_BOT_USERNAME
  
  // если указан username бота, редиректим на бота с deep link
  if (botUsername) {
    const botUsernameClean = botUsername.replace('@', '').replace('https://t.me/', '')
    const deepLink = `https://t.me/${botUsernameClean}?start=order_${InvId}_success`
    return res.redirect(deepLink)
  }
  
  // fallback: редирект на фронтенд (если username бота не указан)
  const webappUrl = process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly'
  res.redirect(`${webappUrl}/payment/success?orderId=${InvId}`)
}

// успешная оплата (Success URL) - GET (рекомендуемый метод)
app.get('/api/robokassa/success', handleSuccessUrl);

// успешная оплата (Success URL) - POST (для совместимости)
app.post('/api/robokassa/success', express.urlencoded({ extended: true }), handleSuccessUrl);

// обработчик для Fail URL (поддерживает GET и POST)
const handleFailUrl = (req: express.Request, res: express.Response) => {
  // получаем InvId из query (GET) или body (POST)
  const InvId = req.query.InvId || req.body?.InvId
  const botUsername = process.env.TG_BOT_USERNAME
  
  // обновляем статус заказа на failed (преобразуем invoiceId в orderId)
  if (InvId) {
    const orderId = `ORD-${InvId}`
    updateOrderStatus(orderId, 'failed')
    logger.info({ InvId, orderId }, 'статус заказа обновлен на failed')
  }
  
  // если указан username бота, редиректим на бота с deep link
  if (botUsername) {
    const botUsernameClean = botUsername.replace('@', '').replace('https://t.me/', '')
    const deepLink = `https://t.me/${botUsernameClean}?start=order_${InvId}_fail`
    return res.redirect(deepLink)
  }
  
  // fallback: редирект на фронтенд (если username бота не указан)
  const webappUrl = process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly'
  res.redirect(`${webappUrl}/payment/fail?orderId=${InvId}`)
}

// неудачная оплата (Fail URL) - GET (рекомендуемый метод)
app.get('/api/robokassa/fail', handleFailUrl);

// неудачная оплата (Fail URL) - POST (для совместимости)
app.post('/api/robokassa/fail', express.urlencoded({ extended: true }), handleFailUrl);

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


