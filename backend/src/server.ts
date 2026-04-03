import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import { fetchProductsFromSheet } from './sheets.js';
import { listProducts, upsertProducts, decreaseProductStock } from './store.js';
import { createOrder, getOrder, updateOrderStatus, type OrderStatus, type Platform } from './orders.js';
import { generatePaymentUrl, verifyResultSignature } from './robokassa.js';
import { fetchPromocodesFromSheet, loadPromocodes, findPromocode, validatePromocode, listPromocodes } from './promocodes.js';
import { fetchOrdersSettingsFromSheet } from './settings.js';
import { fetchCategoriesFromSheet } from './categories.js';

const logger = pino();
const app = express();

// нормализация номера телефона в формат +7XXXXXXXXXX
function normalizePhone(phone: string): string {
  if (!phone) return phone
  const digits = phone.replace(/\D/g, '') // только цифры
  if (digits.length === 10) return `+7${digits}`           // 9028144475 → +79028144475
  if (digits.length === 11 && digits[0] === '7') return `+${digits}` // 79028144475 → +79028144475
  if (digits.length === 11 && digits[0] === '8') return `+7${digits.slice(1)}` // 89028144475 → +79028144475
  return phone // не трогаем нераспознанные форматы (международные)
}

// функция экранирования HTML для защиты от XSS
function escapeHtml(text: string): string {
  if (!text) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}


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

// автоматический импорт промокодов из google sheets
async function importPromocodes() {
  const sheetId = process.env.IMPORT_SHEET_ID;
  if (!sheetId) {
    logger.warn('IMPORT_SHEET_ID не задан, импорт промокодов пропущен');
    return;
  }
  try {
    logger.info('импорт промокодов из google sheets...');
    const promocodes = await fetchPromocodesFromSheet(sheetId);
    loadPromocodes(promocodes);
    logger.info({ imported: promocodes.length }, 'промокоды импортированы');
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка импорта промокодов');
  }
}

// импорт настроек заказов из google sheets (только для чтения, не кешируем)
// настройки читаются напрямую из таблицы при каждом запросе
async function importOrdersSettings() {
  const sheetId = process.env.IMPORT_SHEET_ID;
  if (!sheetId) {
    logger.warn('IMPORT_SHEET_ID не задан, импорт настроек заказов пропущен');
    return;
  }
  try {
    logger.info('проверка настроек заказов из google sheets...');
    const settings = await fetchOrdersSettingsFromSheet(sheetId);
    logger.info({ ordersClosed: settings.ordersClosed, closeDate: settings.closeDate }, 'настройки заказов проверены');
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка проверки настроек заказов');
  }
}

app.use(express.json({ limit: '1mb' }));

// настройка CORS - разрешаем запросы от TG и MAX мини-аппов
const allowedOrigins = [
  process.env.TG_WEBAPP_URL,
  process.env.MAX_WEBAPP_URL,
].filter(Boolean) as string[]

if (allowedOrigins.length === 0) {
  logger.warn('⚠️  TG_WEBAPP_URL и MAX_WEBAPP_URL не заданы! CORS запрещён для всех источников.')
}

app.use(cors({
  origin: (origin, callback) => {
    // разрешаем запросы без origin (curl, Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('CORS not allowed'))
    }
  },
  credentials: true
}));

// rate limiting для защиты от DDoS и брутфорса
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // максимум 100 запросов с одного IP за 15 минут
  message: { error: 'too_many_requests' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: express.Request, res: express.Response) => {
    logger.warn({ 
      ip: req.ip, 
      path: req.path,
      method: req.method 
    }, 'rate limit превышен')
    res.status(429).json({ error: 'too_many_requests' })
  }
})

// более строгий лимит для создания заказов
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 10, // максимум 10 заказов с одного IP за 15 минут
  message: { error: 'too_many_orders' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: express.Request, res: express.Response) => {
    logger.warn({ 
      ip: req.ip, 
      path: req.path 
    }, 'rate limit для заказов превышен')
    res.status(429).json({ error: 'too_many_orders' })
  }
})

// применяем общий rate limiting ко всем запросам
app.use(generalLimiter)

// health
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// регистрация пользователя мини-аппа (вызывается при открытии, до любого заказа)
app.post('/api/register-user', (req, res) => {
  try {
    const { initData, platform } = req.body
    if (!initData || !platform) {
      res.json({ ok: false, reason: 'missing fields' })
      return
    }

    const { id: userId } = extractUserFromInitData(initData)
    if (!userId) {
      res.json({ ok: false, reason: 'no user id' })
      return
    }

    const filePath = platform === 'max'
      ? (process.env.MAX_USERS_FILE || '/opt/bot/max-bot/user-chat-ids.json')
      : (process.env.TG_USERS_FILE || '/opt/bot/bot/user-chat-ids.json')

    // читаем текущий список, добавляем ID, сохраняем
    let ids: (string | number)[] = []
    try {
      if (fs.existsSync(filePath)) {
        ids = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      }
    } catch { ids = [] }

    const userIdNum = Number(userId)
    const idToStore = isNaN(userIdNum) ? userId : userIdNum
    if (!ids.includes(idToStore) && !ids.includes(userId)) {
      ids.push(idToStore)
      fs.writeFileSync(filePath, JSON.stringify(ids, null, 2), 'utf8')
      logger.info({ platform, userId }, 'новый пользователь зарегистрирован через мини-апп')
    }

    res.json({ ok: true })
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'ошибка register-user')
    res.json({ ok: false })
  }
});

// products
app.get('/api/products', (_req, res) => {
  const items = listProducts().filter(p => p.active)
  res.json({ items, total: items.length });
});

// получение категорий (для мини-приложения)
app.get('/api/categories', async (_req, res) => {
  try {
    const sheetId = process.env.IMPORT_SHEET_ID;
    if (!sheetId) {
      return res.json({ categories: [] });
    }
    const categories = await fetchCategoriesFromSheet(sheetId);
    return res.json({ categories });
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка получения категорий');
    return res.json({ categories: [] });
  }
});

// получение статуса заказов
app.get('/api/settings/orders-status', async (_req, res) => {
  try {
    const sheetId = process.env.IMPORT_SHEET_ID
    if (!sheetId) {
      logger.warn('IMPORT_SHEET_ID не задан, возвращаем ordersClosed: false')
      return res.json({ ordersClosed: false })
    }
    
    logger.info('запрос статуса заказов')
    const settings = await fetchOrdersSettingsFromSheet(sheetId)
    logger.info({ ordersClosed: settings.ordersClosed, closeDate: settings.closeDate }, 'статус заказов получен')
    res.json(settings)
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка получения статуса заказов')
    // при ошибке возвращаем, что заказы открыты
    res.json({ ordersClosed: false })
  }
});

// проверка промокода
app.post('/api/promocodes/validate', async (req, res) => {
  try {
    const { code, orderTotal, orderItemSlugs } = req.body
    
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'invalid_code' })
    }
    
    if (typeof orderTotal !== 'number' || orderTotal <= 0) {
      return res.status(400).json({ error: 'invalid_order_total' })
    }
    
    const promocode = findPromocode(code)
    if (!promocode) {
      return res.json({ valid: false, error: 'not_found' })
    }
    
    // передаем товары из корзины для проверки привязки промокода к товарам
    const itemSlugs = Array.isArray(orderItemSlugs) 
      ? orderItemSlugs.filter((slug: any) => typeof slug === 'string')
      : []
    
    const discount = validatePromocode(promocode, orderTotal, itemSlugs)
    if (discount === null) {
      return res.json({ valid: false, error: 'invalid' })
    }
    
    res.json({
      valid: true,
      discount,
      type: promocode.type,
      value: promocode.value
    })
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка проверки промокода')
    res.status(500).json({ error: 'validation_failed' })
  }
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

// отправка сообщения через MAX Bot API
async function sendMaxMessage(chatId: string | number, text: string) {
  const token = process.env.MAX_BOT_TOKEN
  if (!token) {
    logger.warn('MAX_BOT_TOKEN не задан, сообщение не отправлено')
    return false
  }

  try {
    const response = await fetch(`https://platform-api.max.ru/messages?user_id=${chatId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify({ text, format: 'html' })
    })

    if (!response.ok) {
      const error = await response.text()
      logger.error({ error }, 'ошибка отправки сообщения в MAX')
      return false
    }

    return true
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка отправки сообщения в MAX')
    return false
  }
}

// строим deep link для возврата после оплаты (зависит от платформы)
function buildPaymentReturnLink(platform: Platform | undefined, invoiceId: string | number, status: 'success' | 'fail'): string | null {
  if (platform === 'max') {
    const botUsername = process.env.MAX_BOT_USERNAME
    if (botUsername) {
      return `https://max.ru/${botUsername.replace('@', '')}?start=order_${invoiceId}_${status}`
    }
    const webappUrl = process.env.MAX_WEBAPP_URL
    return webappUrl ? `${webappUrl}/payment/${status}?orderId=${invoiceId}` : null
  }

  // telegram (default)
  const botUsername = process.env.TG_BOT_USERNAME
  if (botUsername) {
    const clean = botUsername.replace('@', '').replace('https://t.me/', '')
    return `https://t.me/${clean}?start=order_${invoiceId}_${status}`
  }
  return null
}

// извлекаем данные пользователя из initData (упрощенная версия без проверки подписи для MVP)
function extractUserFromInitData(initData: string): { id: string | null; displayName: string | null } {
  if (!initData) return { id: null, displayName: null }

  try {
    const params = new URLSearchParams(initData)
    const userParam = params.get('user')
    if (userParam) {
      const user = JSON.parse(userParam)
      const id = user.id?.toString() || null
      const nameParts = [user.first_name, user.last_name].filter(Boolean)
      const displayName = nameParts.length > 0 ? nameParts.join(' ') : null
      return { id, displayName }
    }
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'не удалось извлечь данные из initData')
  }

  return { id: null, displayName: null }
}


// отправка уведомлений о заказе (вызывается после успешной оплаты)
async function sendOrderNotifications(order: any) {
  // экранируем HTML для защиты от XSS
  // для покупателя: товар (арт: 0000) × 1 = 1 р.
  const itemsTextForCustomer = order.orderData.items.map((item: any) => {
    const articleText = item.article ? ` (арт: ${escapeHtml(item.article)})` : ''
    return `• ${escapeHtml(item.title)}${articleText} × ${item.quantity} — ${item.price * item.quantity} ₽`
  }).join('\n')
  
  // для менеджера: товар [0001] × 1 — 1 ₽
  const itemsTextForManager = order.orderData.items.map((item: any) => {
    const articleText = item.article ? ` (арт: ${escapeHtml(item.article)})` : ''
    return `• ${escapeHtml(item.title)}${articleText} × ${item.quantity} — ${item.price * item.quantity} ₽`
  }).join('\n')
  
  const priorityCustomerLine =
    order.orderData.priorityOrder && order.orderData.priorityFee
      ? `\nПриоритетный заказ (+30%): ${order.orderData.priorityFee} ₽`
      : ''

  const customerMessage = `
🎉 <b>Ваш заказ оформлен!</b>

Номер заказа: <code>${escapeHtml(order.orderId)}</code>

Товары:
${itemsTextForCustomer}

Доставка: ${order.orderData.deliveryCost} ₽${priorityCustomerLine}
Итого: ${order.orderData.total} ₽

${order.orderData.deliveryRegion === 'europe' ? '📍 Адрес доставки:' : '📍 Пункт СДЭК:'}
${escapeHtml(order.orderData.address)}

Ваш заказ будет отправлен в течении 3-5 дней, мы пришлем уведомление с трек номером для отслеживания. Благодарим за заказ 🤍

💬 Для связи: @${(process.env.SUPPORT_USERNAME || 'semyonp88').replace('@', '')}
  `.trim()
  
  const priorityManagerHeader =
    order.orderData.priorityOrder && order.orderData.priorityFee
      ? `🚨 <b>ПРИОРИТЕТНЫЙ ЗАКАЗ</b> 🚨\n\n`
      : ''

  const priorityManagerLine =
    order.orderData.priorityOrder && order.orderData.priorityFee
      ? `Приоритет (+30%): ${order.orderData.priorityFee} ₽\n`
      : ''

  const managerMessage = `
${priorityManagerHeader}🛒 <b>Новый заказ!</b>

Номер: <code>${escapeHtml(order.orderId)}</code>
Покупатель: ${escapeHtml(order.orderData.fullName)}
Телефон: ${escapeHtml(order.orderData.phone)}
${order.platform === 'max'
  ? `MAX: ${order.customerName ? escapeHtml(order.customerName) : '—'}${order.customerChatId ? `, ID: <code>${order.customerChatId}</code>` : ''}`
  : `TG: ${order.orderData.username ? escapeHtml(order.orderData.username) : 'не указан'}`
}

${order.orderData.deliveryRegion === 'europe' ? '📍 Адрес доставки:' : '📍 Пункт СДЭК:'}
${escapeHtml(order.orderData.country)}, ${escapeHtml(order.orderData.city)}
${escapeHtml(order.orderData.address)}

Товары:
${itemsTextForManager}

Доставка: ${order.orderData.deliveryCost} ₽ (${order.orderData.deliveryRegion})
${priorityManagerLine}Итого: ${order.orderData.total} ₽

${order.orderData.comments ? `Комментарии: ${escapeHtml(order.orderData.comments)}` : ''}
  `.trim()
  
  // выбираем транспорт и chat_id менеджера в зависимости от платформы
  const isMax = order.platform === 'max'
  const sendPlatformMessage = isMax ? sendMaxMessage : sendTelegramMessage
  const managerChatId = isMax ? process.env.MAX_MANAGER_CHAT_ID : process.env.TG_MANAGER_CHAT_ID

  // отправляем покупателю если есть chat_id
  if (order.customerChatId) {
    await sendPlatformMessage(order.customerChatId, customerMessage)
  } else {
    logger.warn({ platform: order.platform }, 'chat_id покупателя не найден, сообщение покупателю не отправлено')
  }

  // отправляем менеджеру
  if (managerChatId) {
    if (order.customerChatId !== managerChatId) {
      await sendPlatformMessage(managerChatId, managerMessage)
    } else {
      await sendPlatformMessage(managerChatId, managerMessage)
      logger.info('покупатель является менеджером, отправлено второе сообщение')
    }
  } else {
    logger.warn({ platform: order.platform }, `MANAGER_CHAT_ID не задан, сообщение менеджеру не отправлено`)
  }
}

// оформление заказа (создаем заказ и возвращаем URL для оплаты)
app.post('/api/orders', orderLimiter, async (req, res) => {
  try {
    const orderData = req.body
    
    logger.info({ 
      itemsCount: orderData.items?.length,
      hasInitData: !!orderData.initData,
      deliveryRegion: orderData.deliveryRegion
    }, 'получен запрос на создание заказа')
    
    // проверка статуса заказов
    const sheetId = process.env.IMPORT_SHEET_ID
    if (sheetId) {
      try {
        const settings = await fetchOrdersSettingsFromSheet(sheetId)
        if (settings.ordersClosed) {
          logger.warn('заказ отклонен: заказы закрыты')
          return res.status(403).json({ error: 'orders_closed', closeDate: settings.closeDate })
        }
      } catch (error: any) {
        logger.error({ error: error?.message }, 'ошибка проверки статуса заказов, продолжаем')
        // при ошибке продолжаем обработку заказа
      }
    }
    
    // минимальная проверка - должны быть товары
    if (!orderData.items || !Array.isArray(orderData.items) || orderData.items.length === 0) {
      logger.warn('заказ отклонен: нет товаров в корзине')
      return res.status(400).json({ error: 'invalid_items' })
    }
    
    // пересчитываем цены на бэкенде из актуальных данных товаров (защита от подмены цен)
    const products = listProducts()
    const validatedItems = orderData.items.map((item: any) => {
      const product = products.find(p => p.slug === item.slug && p.active)
      if (!product) {
        logger.warn({ slug: item.slug }, 'товар не найден или неактивен при валидации заказа')
        throw new Error(`Товар ${item.slug} не найден или неактивен`)
      }
      
      // используем актуальную цену и название с бэкенда, игнорируем данные от клиента
      // если есть discount_price_rub - используем её, иначе price_rub
      const actualPrice = product.discount_price_rub !== undefined && product.discount_price_rub > 0
        ? product.discount_price_rub
        : product.price_rub
      
      return {
        slug: product.slug,
        title: product.title,
        price: actualPrice, // актуальная цена с бэкенда (со скидкой если есть)
        quantity: Math.max(1, Math.floor(item.quantity || 1)), // валидация количества
        article: product.article // артикул товара
      }
    })
    
    // проверяем что все товары найдены
    if (validatedItems.length !== orderData.items.length) {
      logger.error({ 
        requested: orderData.items.length, 
        validated: validatedItems.length 
      }, 'не все товары найдены при валидации заказа')
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
    
    // проверка и применение промокода (если передан)
    let promocodeDiscount = 0
    let promocodeInfo: { code: string; type: 'amount' | 'percent'; value: number; discount: number } | undefined = undefined
    
    if (orderData.promocode && typeof orderData.promocode === 'string' && orderData.promocode.trim()) {
      const promocodeCode = orderData.promocode.trim().toUpperCase()
      const promocode = findPromocode(promocodeCode)
      
      if (promocode) {
        const subtotal = itemsTotal + deliveryCost
        const orderItemSlugs = validatedItems.map((item: { slug: string }) => item.slug)
        const discount = validatePromocode(promocode, subtotal, orderItemSlugs)
        
        if (discount !== null && discount > 0) {
          promocodeDiscount = discount
          promocodeInfo = {
            code: promocode.code,
            type: promocode.type,
            value: promocode.value,
            discount: promocodeDiscount
          }
          logger.info({ 
            code: promocodeCode, 
            type: promocode.type, 
            value: promocode.value, 
            discount: promocodeDiscount 
          }, 'промокод применен к заказу')
        } else {
          logger.warn({ code: promocodeCode }, 'промокод недействителен или истек срок действия')
          return res.status(400).json({ error: 'invalid_promocode' })
        }
      } else {
        logger.warn({ code: promocodeCode }, 'промокод не найден')
        return res.status(400).json({ error: 'promocode_not_found' })
      }
    }
    
    // сумма после товаров, доставки и промокода (база для +30% приоритета)
    const subtotalAfterDiscount = Math.max(0, itemsTotal + deliveryCost - promocodeDiscount)
    const priorityOrder = Boolean(orderData.priorityOrder)
    const priorityFee =
      priorityOrder && subtotalAfterDiscount > 0
        ? Math.round(subtotalAfterDiscount * 0.3)
        : 0
    const total = subtotalAfterDiscount + priorityFee
    
    // Робокасса требует числовой InvId, используем timestamp
    // но сохраняем префикс для внутреннего использования
    const timestamp = Date.now()
    const orderId = `ORD-${timestamp}`
    const invoiceId = String(timestamp) // числовой ID для Робокассы
    
    // получаем данные покупателя из initData
    const initDataUser = orderData.initData ? extractUserFromInitData(orderData.initData) : { id: null, displayName: null }
    const customerChatId = initDataUser.id

    // определяем платформу заказа (telegram по умолчанию для обратной совместимости)
    const orderPlatform: Platform = orderData.platform === 'max' ? 'max' : 'telegram'

    // создаем заказ со статусом pending (используем пересчитанные данные)
    const order = createOrder(orderId, {
      items: validatedItems, // используем валидированные товары с актуальными ценами
      fullName: orderData.fullName || '',
      phone: normalizePhone(orderData.phone || ''),
      username: orderData.username,
      country: orderData.country || '',
      city: orderData.city || '',
      address: orderData.address || '',
      deliveryRegion: orderData.deliveryRegion || '',
      deliveryCost: deliveryCost,
      total: total, // пересчитанная сумма на бэкенде (промокод + приоритет)
      comments: orderData.comments,
      priorityOrder: priorityOrder && priorityFee > 0,
      priorityFee: priorityFee > 0 ? priorityFee : undefined,
      promocode: promocodeInfo
    }, customerChatId, orderPlatform, initDataUser.displayName)

    logger.info({
      orderId,
      itemsCount: validatedItems.length,
      itemsTotal,
      deliveryCost,
      promocodeDiscount,
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

    // Для MAX: после оплаты Робокасса редиректит на бэкенд, который строит MAX deep link.
    // Для TG: редирект сразу на GitHub Pages (мини-апп показывает страницу успеха).
    let successUrl: string
    let failUrl: string
    if (orderPlatform === 'max') {
      const backendUrl = process.env.BACKEND_URL || 'https://shop-koshekjewerly.onrender.com'
      successUrl = `${backendUrl}/api/robokassa/success`
      failUrl = `${backendUrl}/api/robokassa/fail`
    } else {
      successUrl = `${webappUrl}/payment/success`
      failUrl = `${webappUrl}/payment/fail`
    }

    const paymentUrl = generatePaymentUrl({
      orderId, // внутренний ID для логирования
      invoiceId, // числовой ID для Робокассы
      amount: total, // используем пересчитанную сумму, а не от клиента
      description: `Заказ ${orderId}`,
      successUrl,
      failUrl
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
    
    logger.info({ 
      OutSum, 
      InvId, 
      hasSignature: !!SignatureValue,
      additionalParamsCount: Object.keys(additionalParams).length,
      ip: req.ip
    }, 'получен callback от Робокассы (Result URL)')
    
    // проверяем формат InvId (должен быть числом) - делаем это первым
    const invoiceIdNum = parseInt(InvId, 10)
    if (!InvId || isNaN(invoiceIdNum) || invoiceIdNum <= 0) {
      logger.error({ 
        InvId, 
        parsed: invoiceIdNum,
        type: typeof InvId 
      }, 'невалидный формат InvId от Робокассы')
      return res.status(400).send('ERROR')
    }
    
    // проверяем подпись
    const isValid = verifyResultSignature({
      outSum: OutSum,
      invoiceId: InvId,
      signature: SignatureValue,
      additionalParams
    })
    
    if (!isValid) {
      logger.error({ 
        InvId, 
        hasSignature: !!SignatureValue,
        signatureLength: SignatureValue?.length 
      }, 'неверная подпись от Робокассы')
      return res.status(400).send('ERROR')
    }
    
    logger.info({ InvId }, 'подпись от Робокассы проверена успешно')
    
    // находим заказ по invoiceId (преобразуем в orderId)
    // Робокасса возвращает числовой InvId, а у нас заказ хранится по orderId (ORD-timestamp)
    const orderId = `ORD-${InvId}`
    const order = getOrder(orderId)
    if (!order) {
      logger.error({ 
        InvId, 
        orderId,
        searchedOrderId: orderId 
      }, 'заказ не найден по InvId от Робокассы')
      return res.status(404).send('ERROR')
    }
    
    logger.info({ 
      InvId, 
      orderId, 
      currentStatus: order.status 
    }, 'заказ найден, проверяем сумму')
    
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
        // получаем товар до уменьшения для логирования
        const productBefore = listProducts().find(p => p.slug === item.slug)
        const stockBefore = productBefore?.stock
        
        const success = decreaseProductStock(item.slug, item.quantity)
        
        // получаем товар после уменьшения для проверки
        const productAfter = listProducts().find(p => p.slug === item.slug)
        const stockAfter = productAfter?.stock
        
        if (!success) {
          logger.warn({ 
            slug: item.slug, 
            quantity: item.quantity,
            stockBefore,
            stockAfter
          }, 'не удалось уменьшить stock товара (возможно stock undefined или недостаточно)')
        } else {
          logger.info({ 
            slug: item.slug, 
            quantity: item.quantity,
            stockBefore,
            stockAfter,
            decreased: stockBefore !== undefined && stockAfter !== undefined ? stockBefore - stockAfter : 'N/A'
          }, 'stock товара уменьшен в памяти')
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

  // определяем платформу заказа для правильного deep link
  const orderId = `ORD-${InvId}`
  const order = getOrder(orderId)
  const platform = order?.platform ?? 'telegram'

  const deepLink = buildPaymentReturnLink(platform, InvId, 'success')
  if (deepLink) {
    return res.redirect(deepLink)
  }

  // fallback: редирект на фронтенд соответствующей платформы
  const webappUrl = platform === 'max'
    ? (process.env.MAX_WEBAPP_URL || process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly')
    : (process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly')
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

  // обновляем статус заказа на failed и определяем платформу
  let platform: Platform = 'telegram'
  if (InvId) {
    const orderId = `ORD-${InvId}`
    const order = getOrder(orderId)
    platform = order?.platform ?? 'telegram'
    updateOrderStatus(orderId, 'failed')
    logger.info({ InvId, orderId, platform }, 'статус заказа обновлен на failed')
  }

  const deepLink = buildPaymentReturnLink(platform, InvId, 'fail')
  if (deepLink) {
    return res.redirect(deepLink)
  }

  // fallback: редирект на фронтенд соответствующей платформы
  const webappUrl = platform === 'max'
    ? (process.env.MAX_WEBAPP_URL || process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly')
    : (process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly')
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
  
  // устанавливаем таймаут для ответа (30 секунд)
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'import_timeout', message: 'Импорт превысил время ожидания' });
    }
  }, 30000);
  
  try {
    logger.info('начат ручной импорт товаров, промокодов и настроек заказов');
    await importProducts();
    await importPromocodes();
    await importOrdersSettings();
    const count = listProducts().length;
    const promocodesCount = listPromocodes().length;
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.json({ ok: true, total: count, promocodes: promocodesCount });
    }
  } catch (e: any) {
    clearTimeout(timeout);
    logger.error({ error: e?.message, stack: e?.stack }, 'ошибка ручного импорта');
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || 'import_failed' });
    }
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
  await importPromocodes();
  
  // периодический импорт (по умолчанию каждые 10 минут)
  const intervalMinutes = Number(process.env.IMPORT_INTERVAL_MINUTES ?? 10);
  if (intervalMinutes > 0) {
    setInterval(() => {
      importProducts();
      importPromocodes();
    }, intervalMinutes * 60 * 1000);
    logger.info({ intervalMinutes }, 'периодический импорт настроен');
  }
});


