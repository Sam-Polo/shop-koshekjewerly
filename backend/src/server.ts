import 'dotenv/config';
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { fetchProductsFromSheet } from './sheets.js';
import { listProducts, upsertProducts, decreaseProductStock } from './store.js';
import { createOrder, getOrder, updateOrderStatus, listOrders, type Order, type Platform } from './orders.js';
import { appendOrderToSheet, updateOrderStatusInSheet, ensureOrderSheets, getOrderFromSheet, updateOrderAdminNoteInSheet, getOrdersByCustomerChatId } from './orders-sheet.js'
import { sendAlert } from './alerts.js';
import { generatePaymentUrl, verifyResultSignature, queryOrderState } from './robokassa.js';
import { fetchPromocodesFromSheet, loadPromocodes, findPromocode, validatePromocode, listPromocodes } from './promocodes.js';
import { getCachedOrdersSettings } from './settings.js';
import { getCachedCategories } from './categories.js';
import {
  fetchBasesFromSheet,
  fetchPendantsFromSheet,
  setCachedBases,
  setCachedPendants,
  getCachedBases,
  getCachedPendants,
  basesForType,
  pendantsForType,
  effectiveLimit,
  JEWELRY_TYPES,
  type JewelryType
} from './constructor.js';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0,
  })
}

const logger = pino();
const app = express();

// нормализация номера телефона в формат +7XXXXXXXXXX
// убирает все не-цифры, затем приводит к +7XXXXXXXXXX
// поддерживает форматы: 9028144475 / 79028144475 / 89028144475
//   и с форматированием: +7(902)814-44-75 / 8 902 814 44 75 / +7 902 8144475
function normalizePhone(phone: string): string {
  if (!phone) return phone
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+7${digits}`
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`
  if (digits.length === 12 && digits.startsWith('87')) return `+7${digits.slice(2)}` // редкий случай двойного префикса
  return phone // не трогаем нераспознанные форматы (международные номера)
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
    if (e?.message?.includes('429') || e?.message?.toLowerCase().includes('quota')) {
      sendAlert(`Квота Google Sheets исчерпана при импорте товаров: ${e?.message}`, { tag: 'sheets', level: 'moderate', hint: 'товары не обновятся до сброса квоты — возможно слишком частые импорты', code: 'SHEETS_QUOTA_EXCEEDED' }).catch(() => {})
    }
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

// импорт основ и подвесок конструктора из google sheets
async function importConstructor() {
  const sheetId = process.env.IMPORT_SHEET_ID;
  if (!sheetId) {
    logger.warn('IMPORT_SHEET_ID не задан, импорт конструктора пропущен');
    return;
  }
  try {
    logger.info('импорт основ и подвесок из google sheets...');
    const [bases, pendants] = await Promise.all([
      fetchBasesFromSheet(sheetId),
      fetchPendantsFromSheet(sheetId)
    ]);
    setCachedBases(bases);
    setCachedPendants(pendants);
    logger.info({ bases: bases.length, pendants: pendants.length }, 'компоненты конструктора импортированы');
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка импорта компонентов конструктора');
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
    const settings = await getCachedOrdersSettings(sheetId);
    logger.info({ ordersClosed: settings.ordersClosed, closeDate: settings.closeDate }, 'настройки заказов проверены');
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка проверки настроек заказов');
  }
}

// Render держит сервис за своим load balancer'ом — без trust proxy
// req.ip = адрес прокси (::1) и весь трафик считается одним IP в rate limiter'е
app.set('trust proxy', 1);

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
  max: 300, // максимум 300 запросов с одного IP за 15 минут
  message: { error: 'too_many_requests' },
  standardHeaders: true,
  legacyHeaders: false,
  // health-check и доверенные внутренние запросы ботов не должны выжигать бюджет
  // (бот пингает /health каждые 5 минут + опрашивает /api/pending-users)
  skip: (req: express.Request) => {
    if (req.path === '/health') return true
    const botSecret = process.env.BOT_API_SECRET
    if (botSecret && req.query.secret === botSecret) return true
    return false
  },
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

// in-memory очередь новых пользователей для каждой платформы.
// Боты периодически забирают её через GET /api/pending-users?platform=...&secret=...
// и сами сохраняют в свой user-chat-ids.json.
// Render sleep не страшен — при следующем открытии мини-аппа пользователь снова попадёт в очередь.
const pendingUsers: { tg: Set<number>; max: Set<number> } = { tg: new Set(), max: new Set() }

// регистрация пользователя мини-аппа (вызывается при открытии, до любого заказа)
app.post('/api/register-user', (req, res) => {
  try {
    const { initData, platform } = req.body
    if (!initData || !platform) { res.json({ ok: false, reason: 'missing fields' }); return }

    const { id: userId } = extractUserFromInitData(initData)
    if (!userId) { res.json({ ok: false, reason: 'no user id' }); return }

    const userIdNum = Number(userId)
    if (isNaN(userIdNum)) { res.json({ ok: false, reason: 'invalid user id' }); return }

    const queue = platform === 'max' ? pendingUsers.max : pendingUsers.tg
    const isNew = !queue.has(userIdNum)
    queue.add(userIdNum)
    if (isNew) logger.info({ platform, userId: userIdNum }, 'пользователь добавлен в очередь регистрации')

    res.json({ ok: true })
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'ошибка register-user')
    res.json({ ok: false })
  }
});

// боты забирают очередь новых пользователей и сохраняют в свой файл
app.get('/api/pending-users', (req, res) => {
  const secret = process.env.BOT_API_SECRET
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: 'unauthorized' }); return
  }
  const platform = req.query.platform as string
  const queue = platform === 'max' ? pendingUsers.max : pendingUsers.tg
  const ids = Array.from(queue)
  queue.clear()
  res.json({ ids })
});

// products
app.get('/api/products', (_req, res) => {
  const items = listProducts().filter(p => p.active)
  res.json({ items, total: items.length });
});

// конструктор: список типов украшений
app.get('/api/constructor/types', (_req, res) => {
  res.json({ types: JEWELRY_TYPES });
});

// конструктор: список основ для типа украшения
app.get('/api/constructor/bases', (req, res) => {
  const type = req.query.type as JewelryType
  if (!['necklace', 'earrings', 'bracelet'].includes(type)) {
    return res.status(400).json({ error: 'invalid_type' })
  }
  const bases = basesForType(type).map(b => ({
    id: b.id,
    title: b.title,
    description: b.description,
    images: b.images,
    price: b.price,
    article: b.article,
    badge_text: b.badge_text,
    // нормализуем лимит: null → 1 (дефолт), 0 → без ограничения, N → максимум
    limit: effectiveLimit(b, type)
  }))
  res.json({ bases })
});

// конструктор: список подвесок для типа украшения
app.get('/api/constructor/pendants', (req, res) => {
  const type = req.query.type as JewelryType
  if (!['necklace', 'earrings', 'bracelet'].includes(type)) {
    return res.status(400).json({ error: 'invalid_type' })
  }
  const pendants = pendantsForType(type).map(p => ({
    id: p.id,
    title: p.title,
    description: p.description,
    images: p.images,
    price: p.price,
    article: p.article,
    badge_text: p.badge_text,
    removable: p.removable
  }))
  res.json({ pendants })
});

// получение категорий (для мини-приложения)
app.get('/api/categories', async (_req, res) => {
  try {
    const sheetId = process.env.IMPORT_SHEET_ID;
    if (!sheetId) {
      return res.json({ categories: [] });
    }
    const categories = await getCachedCategories(sheetId);
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
    const settings = await getCachedOrdersSettings(sheetId)
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

// фиксируем неотправленные TG-уведомления для ручного разбора
function recordFailedTgNotification(entry: { chatId: string | number; text: string; error?: string; status?: number }) {
  try {
    const file = path.join(process.cwd(), 'failed-tg-notifications.json')
    let arr: any[] = []
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) arr = parsed
      } catch {}
    }
    arr.push({ timestamp: new Date().toISOString(), ...entry })
    if (arr.length > 1000) arr = arr.slice(-1000)
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8')
  } catch (e: any) {
    logger.error({ error: e?.message }, 'не удалось записать failed-tg-notifications.json')
  }
}

// отправка сообщения через Telegram Bot API: 3 попытки 1/3/9с, на финальном фейле — лог + файл.
// 4xx (кроме 429) считаем финальной ошибкой нашего запроса и не ретраим.
type SendResult = { ok: boolean; status?: number; errorDescription?: string }

// извлекает description из ответа Telegram (JSON вида {"ok":false,"description":"..."})
function extractTgDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.description === 'string') return parsed.description
  } catch {}
  return undefined
}

async function sendTelegramMessage(chatId: string | number, text: string): Promise<SendResult> {
  const token = process.env.TG_BOT_TOKEN
  if (!token) {
    logger.warn('TG_BOT_TOKEN не задан, сообщение не отправлено')
    return { ok: false, errorDescription: 'TG_BOT_TOKEN не задан' }
  }

  const RETRY_DELAYS_MS = [1000, 3000, 9000]
  let lastError: string | undefined
  let lastStatus: number | undefined

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      })

      if (response.ok) return { ok: true, status: response.status }

      const errorText = await response.text().catch(() => '')
      lastError = errorText || `HTTP ${response.status}`
      lastStatus = response.status

      // 4xx (кроме 429) ретраить бесполезно — это ошибка нашего запроса
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        logger.error({ chatId, status: response.status, error: errorText }, 'TG sendMessage: финальная 4xx, ретрая не будет')
        recordFailedTgNotification({ chatId, text, error: lastError, status: lastStatus })
        return { ok: false, status: lastStatus, errorDescription: extractTgDescription(errorText) ?? lastError }
      }
    } catch (e: any) {
      lastError = e?.message || 'unknown'
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt]
      logger.warn({ attempt: attempt + 1, error: lastError, delayMs: delay }, 'TG sendMessage: повтор')
      await new Promise<void>(r => setTimeout(r, delay))
    }
  }

  logger.error({ chatId, error: lastError, status: lastStatus }, 'TG sendMessage: все попытки исчерпаны')
  recordFailedTgNotification({ chatId, text, error: lastError, status: lastStatus })
  return { ok: false, status: lastStatus, errorDescription: extractTgDescription(lastError) ?? lastError }
}

// отправка сообщения через MAX Bot API
async function sendMaxMessage(chatId: string | number, text: string): Promise<SendResult> {
  const token = process.env.MAX_BOT_TOKEN
  if (!token) {
    logger.warn('MAX_BOT_TOKEN не задан, сообщение не отправлено')
    return { ok: false, errorDescription: 'MAX_BOT_TOKEN не задан' }
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
      return { ok: false, status: response.status, errorDescription: error || `HTTP ${response.status}` }
    }

    return { ok: true, status: response.status }
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка отправки сообщения в MAX')
    return { ok: false, errorDescription: e?.message || 'unknown' }
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
const DEFAULT_ASSEMBLY_MESSAGE = 'Ваш заказ будет отправлен в течении 3-5 дней, мы пришлем уведомление с трек номером для отслеживания. Благодарим за заказ 🤍'

async function sendOrderNotifications(order: any) {
  // читаем assembly_message из настроек (с фоллбэком на дефолтный текст)
  let assemblyMessage = DEFAULT_ASSEMBLY_MESSAGE
  try {
    const sheetId = process.env.IMPORT_SHEET_ID
    if (sheetId) {
      const settings = await getCachedOrdersSettings(sheetId)
      if (settings.assemblyMessage) {
        assemblyMessage = settings.assemblyMessage
      }
    }
  } catch {
    // при ошибке используем дефолтный текст
  }

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

${assemblyMessage}

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
  const managerChatId = isMax ? process.env.MAX_MANAGER_CHAT_ID : (process.env.TG_ORDERS_CHANNEL_ID || process.env.TG_MANAGER_CHAT_ID)

  // отправляем покупателю если есть chat_id
  // фиксируем результат, чтобы при провале алертнуть менеджера со всеми данными заказа
  let customerDelivery: SendResult = { ok: false, errorDescription: 'chat_id покупателя не найден в initData' }
  if (order.customerChatId) {
    customerDelivery = await sendPlatformMessage(order.customerChatId, customerMessage)
  } else {
    logger.warn({ platform: order.platform }, 'chat_id покупателя не найден, сообщение покупателю не отправлено')
  }

  // классифицируем причину провала для менеджера в человеческом виде
  // chat not found / bot was blocked / user is deactivated → юзер ни разу не открывал чат с ботом
  // или удалил/заблокировал. Прочие случаи — общая формулировка.
  function describeCustomerFailure(r: SendResult): string {
    const desc = (r.errorDescription || '').toLowerCase()
    if (desc.includes('chat not found') || desc.includes("bot can't initiate") || desc.includes('bot was blocked') || desc.includes('user is deactivated')) {
      return 'не начат диалог с ботом, не смогли отправить сообщение покупателю'
    }
    if (desc.includes('chat_id покупателя не найден')) {
      return 'chat_id покупателя не найден (мини-апп открыт без initData)'
    }
    return 'не удалось доставить сообщение покупателю'
  }

  // финальный текст для менеджера: если покупатель не получил — добавляем шапку с причиной
  let managerOutgoing = managerMessage
  if (!customerDelivery.ok) {
    const reason = describeCustomerFailure(customerDelivery)
    const techLine = customerDelivery.status || customerDelivery.errorDescription
      ? `\nДетали: ${customerDelivery.status ? `HTTP ${customerDelivery.status}` : ''}${customerDelivery.status && customerDelivery.errorDescription ? ' — ' : ''}${customerDelivery.errorDescription ? escapeHtml(customerDelivery.errorDescription) : ''}`
      : ''
    managerOutgoing = `⚠️ <b>ПОКУПАТЕЛЬ НЕ ПОЛУЧИЛ УВЕДОМЛЕНИЕ</b>\nПричина: ${reason}${techLine}\nСвяжитесь с покупателем по телефону!\n\n` + managerMessage
  }

  // отправляем менеджеру
  let managerDelivery: SendResult = { ok: false, errorDescription: 'MANAGER_CHAT_ID не задан' }
  if (managerChatId) {
    managerDelivery = await sendPlatformMessage(managerChatId, managerOutgoing)
    if (order.customerChatId === managerChatId) {
      logger.info('покупатель является менеджером, отправлено второе сообщение')
    }
  } else {
    logger.warn({ platform: order.platform }, `MANAGER_CHAT_ID не задан, сообщение менеджеру не отправлено`)
  }

  return { customer: customerDelivery, manager: managerDelivery }
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
        const settings = await getCachedOrdersSettings(sheetId)
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
    const TYPE_TITLES: Record<JewelryType, string> = {
      necklace: 'Колье',
      earrings: 'Серьги',
      bracelet: 'Браслет'
    }

    const validatedItems = orderData.items.map((item: any) => {
      const quantity = Math.max(1, Math.floor(item.quantity || 1))

      // композитный товар (конструктор)
      if (item.kind === 'constructor') {
        const type = item.type as JewelryType
        if (!['necklace', 'earrings', 'bracelet'].includes(type)) {
          logger.warn({ type }, 'композит: неизвестный тип украшения')
          throw new Error(`Конструктор: неизвестный тип украшения "${type}"`)
        }

        const allBases = getCachedBases()
        const base = allBases.find(b => b.id === item.baseId && b.active)
        if (!base) {
          logger.warn({ baseId: item.baseId }, 'композит: основа не найдена')
          throw new Error(`Конструктор: основа не найдена или неактивна`)
        }

        const baseSupportsType =
          (type === 'necklace' && base.for_necklace) ||
          (type === 'earrings' && base.for_earrings) ||
          (type === 'bracelet' && base.for_bracelet)
        if (!baseSupportsType) {
          throw new Error(`Конструктор: основа "${base.title}" не поддерживает тип "${TYPE_TITLES[type]}"`)
        }

        const pendantIds: string[] = Array.isArray(item.pendantIds) ? item.pendantIds : []
        if (pendantIds.length < 1) {
          throw new Error('Конструктор: нужно выбрать минимум одну подвеску')
        }

        const allPendants = getCachedPendants()
        const pendantsResolved = pendantIds.map((pid: string) => {
          const p = allPendants.find(x => x.id === pid && x.active)
          if (!p) throw new Error(`Конструктор: подвеска ${pid} не найдена или неактивна`)
          const pendantSupportsType =
            (type === 'necklace' && p.for_necklace) ||
            (type === 'earrings' && p.for_earrings) ||
            (type === 'bracelet' && p.for_bracelet)
          if (!pendantSupportsType) {
            throw new Error(`Конструктор: подвеска "${p.title}" не поддерживает тип "${TYPE_TITLES[type]}"`)
          }
          return p
        })

        // лимит: если в сборке есть не-съёмная — макс 2 (правило перебивает базовый лимит).
        // иначе используем base.limit (0 = без ограничения).
        const hasNonRemovable = pendantsResolved.some(p => !p.removable)
        const baseLimit = effectiveLimit(base, type)
        if (hasNonRemovable) {
          if (pendantsResolved.length > 2) {
            throw new Error(`Конструктор: с не-съёмной подвеской допускается максимум 2 подвески (выбрано ${pendantsResolved.length})`)
          }
        } else if (baseLimit > 0 && pendantsResolved.length > baseLimit) {
          throw new Error(`Конструктор: превышен лимит подвесок (${pendantsResolved.length}/${baseLimit})`)
        }

        const compositePrice = base.price + pendantsResolved.reduce((s, p) => s + p.price, 0)
        // в названии для менеджера — артикулы в скобках, чтобы их сразу видеть в сообщении
        const fmt = (title: string, art?: string) => art ? `${title} (арт: ${art})` : title
        const pendantTitles = pendantsResolved.map(p => fmt(p.title, p.article)).join(', ')
        const compositeTitle = `${TYPE_TITLES[type]} на заказ: ${fmt(base.title, base.article)} + ${pendantTitles}`

        return {
          slug: `composer-${base.id}-${pendantsResolved.map(p => p.id).join('-')}`,
          title: compositeTitle,
          price: compositePrice,
          quantity,
          article: undefined as string | undefined
        }
      }

      // обычный товар
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
        quantity, // валидация количества
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

    // fire-and-forget запись в Google Sheets (orders + order_items)
    appendOrderToSheet(order).catch(() => {})
    
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
      // query-параметры вместо path — GitHub Pages отдаёт 404 на несуществующие пути
      const base = webappUrl.replace(/\/$/, '')
      successUrl = `${base}/?payment=success`
      failUrl = `${base}/?payment=fail`
    }

    const paymentUrl = generatePaymentUrl({
      orderId,
      invoiceId,
      amount: total,
      description: `Заказ ${orderId}`,
      successUrl,
      failUrl,
      platform: orderPlatform // передаётся как Shp_platform, вернётся в success/fail URL
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
    sendAlert(`Ошибка создания заказа: ${e?.message}`, { tag: 'orders', level: 'high', hint: 'покупатель не смог оформить заказ — проверьте Robokassa и Sheets', code: 'ORDER_CREATE_FAILED' }).catch(() => {})
    res.status(500).json({ error: e?.message || 'order_failed' })
  }
});

// обработка оплаченного заказа: проверка суммы, обновление статуса, сток, уведомления.
// используется и для live-заказа (из памяти), и для восстановленного из Sheets.
// возвращает 'ok', 'already_paid' или 'amount_mismatch'.
export async function processPaidOrder(
  order: Order,
  outSum: string,
  invId: string,
  orderId: string
): Promise<'ok' | 'already_paid' | 'amount_mismatch'> {
  if (order.status === 'paid') {
    logger.info({ invId, orderId }, 'processPaidOrder: заказ уже paid — пропускаем')
    return 'already_paid'
  }

  if (order.status === 'failed') {
    logger.warn({ invId, orderId }, 'processPaidOrder: заказ был failed, Робокасса подтвердила оплату — обрабатываем как paid')
  }

  const robokassaAmount = parseFloat(outSum)
  const orderAmount = order.orderData.total

  if (Math.abs(robokassaAmount - orderAmount) > 0.01) {
    logger.error({
      invId, orderId, robokassaAmount, orderAmount,
      difference: Math.abs(robokassaAmount - orderAmount)
    }, 'processPaidOrder: сумма от Робокассы не совпадает с суммой заказа')
    sendAlert(
      `Несовпадение суммы! InvId: ${invId}, ожидалось ${orderAmount}₽, получено ${robokassaAmount}₽`,
      { tag: 'robokassa', level: 'high', hint: 'сумма от Robokassa не совпадает с заказом — нужна ручная проверка', code: 'AMOUNT_MISMATCH' }
    ).catch(() => {})
    return 'amount_mismatch'
  }

  // обновляем статус в памяти (может вернуть null для восстановленных заказов — это норма)
  const updatedOrder = updateOrderStatus(orderId, 'paid')
  const paidAt = updatedOrder?.updatedAt ?? Date.now()
  updateOrderStatusInSheet(orderId, 'paid', paidAt).catch(() => {})

  // уменьшаем сток товаров
  for (const item of order.orderData.items) {
    const productBefore = listProducts().find(p => p.slug === item.slug)
    const success = decreaseProductStock(item.slug, item.quantity)
    if (!success) {
      logger.warn({
        slug: item.slug, quantity: item.quantity, stockBefore: productBefore?.stock
      }, 'processPaidOrder: не удалось уменьшить stock товара')
    } else {
      logger.info({
        slug: item.slug, quantity: item.quantity,
        stockAfter: listProducts().find(p => p.slug === item.slug)?.stock
      }, 'processPaidOrder: stock товара уменьшен')
    }
  }

  // отправляем уведомления
  const delivery = await sendOrderNotifications(order)

  logger.info({
    invId, orderId, amount: robokassaAmount,
    customerDelivered: delivery?.customer?.ok ?? false,
    managerDelivered: delivery?.manager?.ok ?? false,
  }, 'processPaidOrder: заказ оплачен, уведомления отправлены')

  if (delivery && !delivery.customer.ok) {
    logger.warn({ invId, orderId, reason: delivery.customer.errorDescription }, 'уведомление покупателю не доставлено — менеджеру отправлен алерт')
    sendAlert(
      `Уведомление покупателю не доставлено по заказу ${orderId}: ${delivery.customer.errorDescription ?? 'неизвестно'}`,
      { tag: 'notification', level: 'low', hint: 'покупатель не получил подтверждение — возможно бот заблокирован или неверный chat_id', code: 'CUSTOMER_NOTIFICATION_FAILED' }
    ).catch(() => {})
  }

  return 'ok'
}

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
      sendAlert(`Неверная подпись Робокассы! InvId: ${InvId}, сумма: ${OutSum}₽`, { tag: 'robokassa', level: 'critical', hint: 'возможно сменился пароль Robokassa или получен поддельный запрос', code: 'ROBOKASSA_SIGNATURE_INVALID' }).catch(() => {})
      return res.status(400).send('ERROR')
    }

    logger.info({ InvId }, 'подпись от Робокассы проверена успешно')

    const orderId = `ORD-${InvId}`
    const order = getOrder(orderId)

    if (!order) {
      // Заказ не найден в памяти — бэкенд перезапускался (Render sleep/deploy).
      // Задача 1.1: пробуем восстановить из Google Sheets.
      const recoveryEnabled = process.env.FEATURE_ORDER_RECOVERY !== 'false'
      if (recoveryEnabled) {
        logger.info({ InvId, orderId }, '1.1: заказ не найден в памяти, пробуем восстановить из Sheets...')
        const recovered = await getOrderFromSheet(orderId)

        if (recovered) {
          if (recovered.sheetStatus === 'paid') {
            // уже обработан ранее (идемпотентность)
            logger.info({ InvId, orderId }, '1.1: заказ уже paid в Sheets — пропускаем повторную обработку')
            return res.send(`OK${InvId}`)
          }

          const result = await processPaidOrder(recovered, OutSum, InvId, orderId)
          if (result === 'amount_mismatch') return res.status(400).send('ERROR')

          if (process.env.FEATURE_DEBUG_ALERTS === 'true') {
            sendAlert(
              `✅ 1.1: ${orderId} восстановлен из Sheets (был ${recovered.sheetStatus}) и обработан`,
              { tag: 'recovery', level: 'info' }
            ).catch(() => {})
          }
          return res.send(`OK${InvId}`)
        }
      }

      // восстановить не удалось — упрощённое уведомление менеджеру + алерт в канал
      logger.error({ InvId, orderId }, 'заказ не найден и восстановить из Sheets не удалось')
      sendAlert(
        `Оплата получена, заказ не найден! InvId: ${InvId}, сумма: ${OutSum}₽. Восстановление из Sheets не удалось — свяжитесь с покупателем.`,
        { tag: 'recovery', level: 'critical', hint: 'бэкенд перезапустился во время оплаты и заказ потерян — нужна ручная обработка', code: 'ORDER_RECOVERY_FAILED' }
      ).catch(() => {})

      const shpPlatform = additionalParams['Shp_platform'] as string | undefined
      const platform: Platform = shpPlatform === 'max' ? 'max' : 'telegram'
      const managerChatId = platform === 'max' ? process.env.MAX_MANAGER_CHAT_ID : process.env.TG_MANAGER_CHAT_ID
      if (managerChatId) {
        const msg = `⚠️ <b>Оплата получена, но заказ не найден в памяти!</b>\n\nInvId: <code>${InvId}</code>\nСумма: ${OutSum} ₽\nПлатформа: ${platform}\n\nВозможно сервер перезапустился во время оплаты. Свяжитесь с покупателем.`
        const send = platform === 'max' ? sendMaxMessage : sendTelegramMessage
        await send(managerChatId, msg).catch(() => {})
      }
      return res.send(`OK${InvId}`)
    }

    // заказ нашёлся в памяти — обычный путь
    logger.info({ InvId, orderId, currentStatus: order.status }, 'заказ найден, обрабатываем')

    // Result URL авторитативен: обрабатываем pending и failed (failed мог выставить превьювер мессенджера).
    if (order.status === 'pending' || order.status === 'failed') {
      const result = await processPaidOrder(order, OutSum, InvId, orderId)
      if (result === 'amount_mismatch') return res.status(400).send('ERROR')
    } else if (order.status === 'paid') {
      logger.info({ InvId, orderId }, 'повторный Result URL для уже paid заказа — игнорируем')
    }

    // Робокасса ожидает ответ "OK<InvId>"
    res.send(`OK${InvId}`)
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка обработки callback от Робокассы')
    sendAlert(`Ошибка обработки Result URL: ${e?.message}`, { tag: 'robokassa', level: 'high', hint: 'необработанное исключение при получении оплаты — возможна потеря заказа', code: 'RESULT_URL_EXCEPTION' }).catch(() => {})
    res.status(500).send('ERROR')
  }
});

// обработчик для Success URL (поддерживает GET и POST)
const handleSuccessUrl = (req: express.Request, res: express.Response) => {
  const InvId = req.query.InvId || req.body?.InvId
  // Shp_platform передан Робокассой обратно — не зависит от in-memory заказа
  const shpPlatform = (req.query.Shp_platform || req.body?.Shp_platform) as string | undefined
  const platform: Platform = shpPlatform === 'max' ? 'max' : 'telegram'

  logger.info({ InvId, platform, shpPlatform }, 'success URL: определена платформа')

  const deepLink = buildPaymentReturnLink(platform, InvId, 'success')
  if (deepLink) return res.redirect(deepLink)

  const base = (platform === 'max'
    ? (process.env.MAX_WEBAPP_URL || process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly')
    : (process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly')).replace(/\/$/, '')
  res.redirect(`${base}/?payment=success&orderId=${InvId}`)
}

// успешная оплата (Success URL) - GET (рекомендуемый метод)
app.get('/api/robokassa/success', handleSuccessUrl);

// успешная оплата (Success URL) - POST (для совместимости)
app.post('/api/robokassa/success', express.urlencoded({ extended: true }), handleSuccessUrl);

// обработчик для Fail URL (поддерживает GET и POST)
// ВАЖНО: Fail URL — это просто браузерный редирект, он НЕ авторитативен.
// Его дёргают краулеры превью мессенджеров, юзер при reload, при закрытии вкладки и т.п.
// Реальный статус оплаты определяет только Result URL (с проверкой подписи Робокассы).
// Поэтому здесь мы НЕ меняем статус заказа, только редиректим юзера обратно в мини-апп.
const handleFailUrl = (req: express.Request, res: express.Response) => {
  const InvId = req.query.InvId || req.body?.InvId
  const shpPlatform = (req.query.Shp_platform || req.body?.Shp_platform) as string | undefined
  const platform: Platform = shpPlatform === 'max' ? 'max' : 'telegram'

  if (InvId) {
    logger.info({ InvId, platform }, 'Fail URL: редирект пользователя в мини-апп (статус заказа не меняем)')
  }

  const deepLink = buildPaymentReturnLink(platform, InvId, 'fail')
  if (deepLink) return res.redirect(deepLink)

  const base = (platform === 'max'
    ? (process.env.MAX_WEBAPP_URL || process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly')
    : (process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly')).replace(/\/$/, '')
  res.redirect(`${base}/?payment=fail&orderId=${InvId}`)
}

// неудачная оплата (Fail URL) - GET (рекомендуемый метод)
app.get('/api/robokassa/fail', handleFailUrl);

// неудачная оплата (Fail URL) - POST (для совместимости)
app.post('/api/robokassa/fail', express.urlencoded({ extended: true }), handleFailUrl);

// повторная отправка уведомления покупателю (вызывается ботом после /start)
// авторизация: Bearer = TG_BOT_TOKEN, чтобы эндпоинт не был публичным
app.post('/api/orders/:orderId/resend-notification', express.json(), async (req, res) => {
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${process.env.TG_BOT_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { orderId } = req.params
  const chatId = req.body?.chatId
  if (!chatId) return res.status(400).json({ error: 'chatId required' })

  const order = getOrder(orderId)
  if (!order) return res.status(404).json({ error: 'order not found' })
  if (order.status !== 'paid') return res.status(400).json({ error: 'order not paid' })

  try {
    let assemblyMessage = 'Ваш заказ будет отправлен в течении 3-5 дней, мы пришлем уведомление с трек номером для отслеживания. Благодарим за заказ 🤍'
    const sheetId = process.env.IMPORT_SHEET_ID
    if (sheetId) {
      const settings = await getCachedOrdersSettings(sheetId).catch(() => null)
      if (settings?.assemblyMessage) assemblyMessage = settings.assemblyMessage
    }

    const itemsText = order.orderData.items.map((item: any) => {
      const art = item.article ? ` (арт: ${escapeHtml(item.article)})` : ''
      return `• ${escapeHtml(item.title)}${art} × ${item.quantity} — ${item.price * item.quantity} ₽`
    }).join('\n')

    const priorityLine = order.orderData.priorityOrder && order.orderData.priorityFee
      ? `\nПриоритетный заказ (+30%): ${order.orderData.priorityFee} ₽` : ''

    const customerMessage = `
🎉 <b>Ваш заказ оформлен!</b>

Номер заказа: <code>${escapeHtml(order.orderId)}</code>

Товары:
${itemsText}

Доставка: ${order.orderData.deliveryCost} ₽${priorityLine}
Итого: ${order.orderData.total} ₽

${order.orderData.deliveryRegion === 'europe' ? '📍 Адрес доставки:' : '📍 Пункт СДЭК:'}
${escapeHtml(order.orderData.address)}

${assemblyMessage}

💬 Для связи: @${(process.env.SUPPORT_USERNAME || 'semyonp88').replace('@', '')}
    `.trim()

    const result = order.platform === 'max'
      ? await sendMaxMessage(String(chatId), customerMessage)
      : await sendTelegramMessage(String(chatId), customerMessage)

    logger.info({ orderId, chatId, ok: result.ok }, 'resend-notification: результат')
    res.json({ ok: result.ok, error: result.ok ? undefined : result.errorDescription })
  } catch (e: any) {
    logger.error({ orderId, error: e?.message }, 'resend-notification: ошибка')
    res.status(500).json({ error: e?.message })
  }
})

// отправка трека покупателю (вызывается ботом из комментария под постом заказа)
app.post('/api/orders/:orderId/send-tracking', express.json(), async (req, res) => {
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${process.env.TG_BOT_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { orderId } = req.params
  const { trackingUrl } = req.body
  if (!trackingUrl || typeof trackingUrl !== 'string') {
    return res.status(400).json({ error: 'trackingUrl required' })
  }

  // ищем заказ: сначала в памяти, потом в Sheets
  let order: Order | null = getOrder(orderId) ?? null
  let adminNote = ''

  const sheetOrder = await getOrderFromSheet(orderId).catch(() => null)
  if (sheetOrder) {
    adminNote = sheetOrder.adminNote || ''
    if (!order) order = sheetOrder
  }

  if (!order) {
    return res.status(404).json({ error: 'order not found' })
  }

  // дедупликация: если трек уже отправлялся
  if (adminNote.includes('track:')) {
    return res.status(409).json({ error: 'already_sent' })
  }

  if (!order.customerChatId) {
    return res.status(400).json({ error: 'no_customer_chat_id' })
  }

  const trackingMessage = [
    '🩷 Ваша посылочка скоро уедет к вам.',
    'Отследить можно по ссылке:',
    '',
    trackingUrl,
    '',
    'Спасибо за заказ, всегда будем счастливы видеть ваши отзывы 🥰'
  ].join('\n')

  const result = order.platform === 'max'
    ? await sendMaxMessage(order.customerChatId, trackingMessage)
    : await sendTelegramMessage(order.customerChatId, trackingMessage)

  if (result.ok) {
    const newNote = adminNote ? `${adminNote}\ntrack: ${trackingUrl}` : `track: ${trackingUrl}`
    await updateOrderAdminNoteInSheet(orderId, newNote).catch(() => {})
    logger.info({ orderId, trackingUrl }, 'трек отправлен покупателю')
    return res.json({ ok: true })
  } else {
    const errDesc = result.errorDescription || `HTTP ${result.status}`
    logger.warn({ orderId, error: errDesc }, 'не удалось отправить трек покупателю')
    return res.json({ ok: false, error: errDesc })
  }
})

// история заказов пользователя (вызывается ботом по команде /myorders)
app.get('/api/orders/my', async (req, res) => {
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${process.env.TG_BOT_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const chatId = (req.query.chatId as string)?.trim()
  if (!chatId) return res.status(400).json({ error: 'chatId required' })

  try {
    const orders = await getOrdersByCustomerChatId(chatId, 10)
    return res.json({ orders })
  } catch (e: any) {
    logger.error({ chatId, error: e?.message }, 'ошибка получения заказов пользователя')
    return res.status(500).json({ error: 'internal_error' })
  }
})

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
    logger.info('начат ручной импорт товаров, промокодов, конструктора и настроек заказов');
    await importProducts();
    await importPromocodes();
    await importConstructor();
    await importOrdersSettings();
    const count = listProducts().length;
    const promocodesCount = listPromocodes().length;
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.json({
        ok: true,
        total: count,
        promocodes: promocodesCount,
        bases: getCachedBases().length,
        pendants: getCachedPendants().length
      });
    }
  } catch (e: any) {
    clearTimeout(timeout);
    logger.error({ error: e?.message, stack: e?.stack }, 'ошибка ручного импорта');
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || 'import_failed' });
    }
  }
});

// 1.2: проверяем статус pending-заказов через Robokassa OpStateExt
// запускается по таймеру; если Result URL пришёл до рестарта — обрабатываем здесь
const POLL_MIN_AGE_MS = 2 * 60 * 1000    // не трогаем только что созданные (ждём Result URL сами придут)
const POLL_MAX_AGE_MS = 24 * 60 * 60 * 1000 // игнорируем старые брошенные заказы

export async function checkPendingOrders(): Promise<void> {
  if (process.env.FEATURE_PAYMENT_POLLING === 'false') return

  const now = Date.now()
  const pending = listOrders().filter(
    (o) =>
      o.status === 'pending' &&
      now - o.createdAt >= POLL_MIN_AGE_MS &&
      now - o.createdAt <= POLL_MAX_AGE_MS
  )

  if (pending.length === 0) return
  logger.info({ count: pending.length }, '1.2: опрашиваем pending-заказы через OpStateExt')

  for (const order of pending) {
    const invId = order.orderId.replace('ORD-', '')
    try {
      const state = await queryOrderState(invId)
      if (!state) continue

      if (state.stateCode === 5) {
        logger.info({ orderId: order.orderId, invId, outSum: state.outSum }, '1.2: Робокасса подтверждает оплату — обрабатываем')
        const result = await processPaidOrder(order, state.outSum, invId, order.orderId)
        if (result === 'ok' && process.env.FEATURE_DEBUG_ALERTS === 'true') {
          sendAlert(`✅ 1.2: ${order.orderId} оплачен (polling), обработан`, { tag: '1.2', level: 'info' }).catch(() => {})
        }
        if (result === 'amount_mismatch') {
          sendAlert(`⚠️ 1.2: ${order.orderId} — расхождение суммы при polling`, { tag: '1.2', level: 'moderate', hint: 'сумма от Robokassa при опросе не совпала с заказом — нужна ручная проверка', code: 'POLLING_AMOUNT_MISMATCH' }).catch(() => {})
        }
      }
    } catch (e: any) {
      logger.warn({ orderId: order.orderId, error: e?.message }, '1.2: ошибка при опросе OpStateExt')
    }
  }
}

// перехватывает ошибки из Express-роутов, которые не поймал try-catch
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app)
}

// глобальные обработчики необработанных ошибок
process.on('uncaughtException', (err) => {
  logger.error({ error: err?.message, stack: err?.stack }, 'uncaughtException')
  sendAlert(`uncaughtException: ${err?.message}`, { tag: 'process', level: 'critical', hint: 'непойманное исключение — процесс мог упасть или нестабилен', code: 'UNCAUGHT_EXCEPTION' }).catch(() => {})
})

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  logger.error({ reason: msg }, 'unhandledRejection')
  sendAlert(`unhandledRejection: ${msg}`, { tag: 'process', level: 'critical', hint: 'необработанный Promise — возможна скрытая ошибка или утечка памяти', code: 'UNHANDLED_REJECTION' }).catch(() => {})
})

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
  await importConstructor();

  // создаём листы для заказов, если их нет
  ensureOrderSheets().catch((e: any) => {
    logger.warn({ error: e?.message }, 'не удалось подготовить листы orders/order_items')
  });

  // периодический импорт (по умолчанию каждые 10 минут)
  const intervalMinutes = Number(process.env.IMPORT_INTERVAL_MINUTES ?? 10);
  if (intervalMinutes > 0) {
    setInterval(() => {
      importProducts();
      importPromocodes();
      importConstructor();
    }, intervalMinutes * 60 * 1000);
    logger.info({ intervalMinutes }, 'периодический импорт настроен');
  }

  // 1.2: периодический опрос статуса платежей
  const pollIntervalMinutes = Number(process.env.PAYMENT_POLL_INTERVAL_MINUTES ?? 5)
  if (process.env.FEATURE_PAYMENT_POLLING !== 'false' && pollIntervalMinutes > 0) {
    setInterval(() => { checkPendingOrders().catch(() => {}) }, pollIntervalMinutes * 60 * 1000)
    logger.info({ intervalMinutes: pollIntervalMinutes }, '1.2: опрос pending-заказов настроен')
  }

  // стартовый self-check — в канал ошибок при каждом рестарте
  if (process.env.FEATURE_DEBUG_ALERTS === 'true') {
    try {
      const commit = process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'local'
      const recoveryOn = process.env.FEATURE_ORDER_RECOVERY !== 'false'
      const pollingOn = process.env.FEATURE_PAYMENT_POLLING !== 'false'
      const settingsTtl = Number(process.env.SETTINGS_CACHE_TTL_SECONDS ?? 300)
      const categoriesTtl = Number(process.env.CATEGORIES_CACHE_TTL_SECONDS ?? 300)
      const channelOk = !!process.env.ERROR_CHANNEL_CHAT_ID
      const robokassaOk = !!(process.env.ROBOKASSA_MERCHANT_LOGIN && process.env.ROBOKASSA_PASSWORD_1 && process.env.ROBOKASSA_PASSWORD_2)
      const sheetsOk = !!process.env.IMPORT_SHEET_ID
      const startMsg =
        `✅ [backend] перезапущен ${commit} | ${new Date().toISOString()}\n` +
        `Recovery (1.1): ${recoveryOn ? 'on' : 'off'}\n` +
        `Polling (1.2): ${pollingOn ? `on (${pollIntervalMinutes}m)` : 'off'}\n` +
        `Cache (1.3): settings ${settingsTtl}s, categories ${categoriesTtl}s\n` +
        `Канал ошибок: ${channelOk ? 'задан' : '⚠️ не задан'}\n` +
        `Robokassa: ${robokassaOk ? 'ok' : '⚠️ не полностью настроена'}\n` +
        `Sheets: ${sheetsOk ? 'ok' : '⚠️ IMPORT_SHEET_ID не задан'}`
      await sendAlert(startMsg, { tag: 'startup', level: 'info' })
    } catch (e: any) {
      logger.warn({ error: e?.message }, 'не удалось отправить startup alert')
    }
  }
});


