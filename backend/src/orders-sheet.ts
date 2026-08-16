import { google } from 'googleapis'
import fs from 'node:fs'
import pino from 'pino'
import type { Order, OrderStatus, Platform, DeliveryMethod } from './orders.js'
import { listProducts } from './store.js'
import { sendAlert } from './alerts.js'

const logger = pino()

const ORDERS_SHEET = 'orders'
const ORDER_ITEMS_SHEET = 'order_items'

// order_status (AC) дописан В КОНЕЦ намеренно: индексы колонок захардкожены
// в getOrderFromSheet и остальных читателях, вставка в середину сдвинула бы всё.
const ORDERS_HEADERS = [
  'order_id', 'created_at', 'updated_at', 'status', 'platform',
  'customer_chat_id', 'customer_name', 'full_name', 'phone', 'username',
  'country', 'city', 'address', 'delivery_region', 'delivery_cost',
  'items_total', 'promocode_code', 'promocode_discount',
  'priority_order', 'priority_fee', 'total', 'client_comment', 'admin_note',
  'cdek_uuid', 'cdek_track_number', 'delivery_method', 'pochta_shpi', 'pd_consent',
  'order_status'
]

/** колонка order_status в листе orders (0-based индекс 28 = буква AC) */
const ORDER_STATUS_COL = 'AC'
const ORDER_STATUS_INDEX = 28
/** колонка delivery_method (0-based индекс 25 = буква Z) */
const DELIVERY_METHOD_COL = 'Z'

export type OrderCustomerStatus = 'Принят' | 'В сборке' | 'В пути' | 'Отправлен' | 'Уже у вас'

/**
 * Ступени пути заказа. Статус умеет двигаться только ВПЕРЁД (см. advanceOrderStatusInSheet).
 *
 * «Отправлен» и «В пути» стоят на ОДНОЙ ступени намеренно: это один и тот же момент,
 * просто у EMS он конечный (Почта не присылает подтверждения вручения, вебхука у неё нет),
 * а у СДЭКа за ним следует «Уже у вас». Заказ едет чем-то одним, поэтому обе метки
 * на одном заказе не встретятся, а одинаковый ранг не даёт им перебивать друг друга.
 */
const STATUS_RANK: Record<string, number> = {
  'Принят': 0,
  'В сборке': 1,
  'В пути': 2,
  'Отправлен': 2,
  'Уже у вас': 3,
}

export function statusRank(status: string): number {
  return STATUS_RANK[status] ?? -1
}

/** для EMS «В пути» показывается как «Отправлен» — и это его конечный статус */
export function labelForDelivery(status: OrderCustomerStatus, deliveryMethod: string): OrderCustomerStatus {
  if (status === 'В пути' && deliveryMethod === 'ems') return 'Отправлен'
  return status
}

// ── Очередь записи статусов ───────────────────────────────────────────────────
//
// Устроена по образцу очереди amoCRM (amocrm-client.ts): один воркер, пауза между
// задачами, ничего не выбрасывается — только выстраивается в линию.
//
// Зачем: у Google Sheets лимит ~60 операций записи в минуту, а одна простановка статуса
// это batchGet + update, то есть два обращения. Менеджер, разгребающий дроп пачкой,
// роняет на нас десятки вебхуков подряд — без паузы мы гарантированно ловим 429,
// и статусы у части заказов просто не проставляются.
//
// Задержка тут ничего не стоит: статус — витрина, его никто не ждёт синхронно.
const STATUS_WRITE_INTERVAL_MS = Number(process.env.ORDER_STATUS_WRITE_INTERVAL_MS ?? '1200')
const STATUS_QUEUE_BACKLOG_ALERT = 50

let statusChain: Promise<unknown> = Promise.resolve()
let statusQueueDepth = 0
let backlogAlerted = false

function queueStatusWrite<T>(task: () => Promise<T>): Promise<T> {
  statusQueueDepth++

  // очередь растёт быстрее, чем разгребается — значит вебхуков штормит; сообщаем один раз
  if (statusQueueDepth >= STATUS_QUEUE_BACKLOG_ALERT && !backlogAlerted) {
    backlogAlerted = true
    sendAlert(
      `Очередь записи статусов заказов выросла до ${statusQueueDepth} — статусы в ЛК отстают от реальности`,
      {
        tag: 'orders', level: 'moderate',
        hint: 'обычно это массовый перенос сделок в amoCRM; очередь разгребётся сама, проверьте что не сыплется 429 от Sheets',
        code: 'ORDER_STATUS_QUEUE_BACKLOG',
      }
    ).catch(() => {})
  }

  const run = statusChain.then(async () => {
    try {
      return await task()
    } finally {
      statusQueueDepth--
      if (statusQueueDepth === 0) backlogAlerted = false
      await new Promise<void>(r => setTimeout(r, STATUS_WRITE_INTERVAL_MS))
    }
  })
  // цепочку продолжаем «очищенной» — падение одной задачи не должно рвать очередь
  statusChain = run.catch(() => {})
  return run as Promise<T>
}

/** глубина очереди — для тестов и диагностики */
export function statusQueueSize(): number {
  return statusQueueDepth
}

const ORDER_ITEMS_HEADERS = [
  'order_id', 'slug', 'title', 'price', 'quantity', 'article', 'category', 'option'
]

function getAuth() {
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  let creds: any
  if (filePath) {
    creds = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } else if (raw) {
    creds = JSON.parse(raw)
  } else {
    throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE is required')
  }
  return new google.auth.JWT(
    creds.client_email,
    undefined,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  )
}

function getSheetId(): string | null {
  return process.env.IMPORT_SHEET_ID || null
}

function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

function resolveItemCategory(slug: string): string {
  if (slug.startsWith('composer-')) return 'constructor'
  const product = listProducts().find(p => p.slug === slug)
  return product?.category || ''
}

/** Преобразует 1-based номер колонки в буквенное обозначение A1 (1→A, 26→Z, 27→AA). */
function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

async function ensureSheet(api: any, spreadsheetId: string, sheetName: string, headers: string[]): Promise<void> {
  const meta = await api.spreadsheets.get({ spreadsheetId })
  const exists = meta.data.sheets?.some((s: any) => s.properties?.title === sheetName)
  if (!exists) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }]
      }
    })
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1:${colLetter(headers.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    })
    logger.info({ sheetName }, 'лист создан')
    return
  }
  const range = `${sheetName}!A1:${colLetter(headers.length)}1`
  const res = await api.spreadsheets.values.get({ spreadsheetId, range })
  const row0 = res.data.values?.[0] || []
  const ok = headers.every((h, i) => row0[i] === h)
  if (!ok) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    })
    logger.info({ sheetName }, 'заголовки листа обновлены')
  }
}

let sheetsEnsured = false

export async function ensureOrderSheets(): Promise<void> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return
  if (sheetsEnsured) return
  const auth = getAuth()
  const api = google.sheets({ version: 'v4', auth })
  await ensureSheet(api, spreadsheetId, ORDERS_SHEET, ORDERS_HEADERS)
  await ensureSheet(api, spreadsheetId, ORDER_ITEMS_SHEET, ORDER_ITEMS_HEADERS)
  sheetsEnsured = true
}

function buildOrderRow(order: Order): (string | number)[] {
  const d = order.orderData
  const itemsTotal = d.items.reduce((s, it) => s + it.price * it.quantity, 0)
  return [
    order.orderId,
    toIso(order.createdAt),
    toIso(order.updatedAt),
    order.status,
    order.platform || 'telegram',
    order.customerChatId ?? '',
    order.customerName ?? '',
    d.fullName || '',
    d.phone || '',
    d.username || '',
    d.country || '',
    d.city || '',
    d.address || '',
    d.deliveryRegion || '',
    d.deliveryCost ?? 0,
    itemsTotal,
    d.promocode?.code || '',
    d.promocode?.discount ?? 0,
    d.priorityOrder ? 'true' : 'false',
    d.priorityFee ?? 0,
    d.total ?? 0,
    d.comments || '',
    '', // admin_note
    order.cdekUuid ?? '',
    order.cdekTrackNumber ?? '',
    d.deliveryMethod ?? '',
    order.pochtaShpi ?? '',
    d.consent ? 'true' : 'false', // pd_consent — согласие на обработку ПДн (152-ФЗ)
  ]
}

function buildItemsRows(order: Order): (string | number)[][] {
  return order.orderData.items.map(it => [
    order.orderId,
    it.slug,
    it.title,
    it.price,
    it.quantity,
    it.article || '',
    resolveItemCategory(it.slug),
    it.option || ''
  ])
}

export async function appendOrderToSheet(order: Order): Promise<void> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return
  try {
    await ensureOrderSheets()
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })
    await api.spreadsheets.values.append({
      spreadsheetId,
      range: `${ORDERS_SHEET}!A:Y`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildOrderRow(order)] }
    })
    const itemsRows = buildItemsRows(order)
    if (itemsRows.length > 0) {
      await api.spreadsheets.values.append({
        spreadsheetId,
        range: `${ORDER_ITEMS_SHEET}!A:H`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: itemsRows }
      })
    }
    logger.info({ orderId: order.orderId, items: itemsRows.length }, 'заказ записан в Google Sheets')
  } catch (e: any) {
    logger.warn({ orderId: order.orderId, error: e?.message }, 'не удалось записать заказ в Google Sheets')
  }
}

export async function updateOrderStatusInSheet(orderId: string, status: string, updatedAtMs: number): Promise<void> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return
  try {
    await ensureOrderSheets()
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })
    const res = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDERS_SHEET}!A:A`
    })
    const rows = res.data.values || []
    let rowNumber = -1
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]?.[0] === orderId) {
        rowNumber = i + 1
        break
      }
    }
    if (rowNumber === -1) {
      logger.warn({ orderId }, 'строка заказа не найдена в Google Sheets для обновления статуса')
      return
    }
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${ORDERS_SHEET}!C${rowNumber}:D${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[toIso(updatedAtMs), status]] }
    })
    logger.info({ orderId, status, rowNumber }, 'статус заказа обновлён в Google Sheets')
  } catch (e: any) {
    logger.error({ orderId, status, error: e?.message }, 'не удалось обновить статус заказа в Google Sheets')
    sendAlert(
      `⚠️ Заказ ${orderId}: статус «${status}» НЕ сохранён в Google Sheets! Обновите вручную.`,
      { tag: 'sheets', level: 'high', hint: 'ошибка записи в Sheets — в памяти статус обновлён, после рестарта Sheets станет авторитетом', code: 'SHEETS_STATUS_UPDATE_FAILED' }
    ).catch(() => {})
  }
}

/**
 * Читает заказ из Google Sheets по orderId (для восстановления после рестарта бэкенда).
 * Возвращает null если заказ не найден или Sheets недоступен.
 * Поля `status` из Sheets используются для idempotency-проверки на стороне вызывающего кода.
 */
export async function getOrderFromSheet(orderId: string): Promise<(Order & { sheetStatus: string; adminNote: string }) | null> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return null
  try {
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })

    // индексы колонок ORDERS_HEADERS (0-based):
    // 0=order_id, 1=created_at, 2=updated_at, 3=status, 4=platform,
    // 5=customer_chat_id, 6=customer_name, 7=full_name, 8=phone, 9=username,
    // 10=country, 11=city, 12=address, 13=delivery_region, 14=delivery_cost,
    // 15=items_total, 16=promocode_code, 17=promocode_discount,
    // 18=priority_order, 19=priority_fee, 20=total, 21=client_comment, 22=admin_note
    // 23=cdek_uuid, 24=cdek_track_number, 25=delivery_method, 26=pochta_shpi
    const ordersRes = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDERS_SHEET}!A:AA`
    })
    const orderRows = ordersRes.data.values || []
    let orderRow: string[] | null = null
    for (let i = 1; i < orderRows.length; i++) {
      if (orderRows[i]?.[0] === orderId) {
        orderRow = orderRows[i] as string[]
        break
      }
    }
    if (!orderRow) {
      logger.warn({ orderId }, 'getOrderFromSheet: строка заказа не найдена в Sheets')
      return null
    }

    const col = (i: number) => orderRow![i] ?? ''
    const sheetStatus = col(3)

    // индексы ORDER_ITEMS_HEADERS (0-based):
    // 0=order_id, 1=slug, 2=title, 3=price, 4=quantity, 5=article, 6=category, 7=option
    const itemsRes = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDER_ITEMS_SHEET}!A:H`
    })
    const itemRows = itemsRes.data.values || []
    const items: Order['orderData']['items'] = []
    for (let i = 1; i < itemRows.length; i++) {
      const row = itemRows[i] as string[]
      if (row?.[0] !== orderId) continue
      items.push({
        slug: row[1] ?? '',
        title: row[2] ?? '',
        price: parseFloat(row[3]) || 0,
        quantity: parseInt(row[4], 10) || 1,
        article: row[5] || undefined,
        // опция обязана пережить рестарт Render: уведомления и лид amoCRM создаются
        // в processPaidOrder, который может работать на восстановленном заказе
        option: row[7] || undefined,
      })
    }

    const deliveryCost = parseFloat(col(14)) || 0
    const total = parseFloat(col(20)) || 0
    const priorityOrder = col(18) === 'true'
    const priorityFee = parseFloat(col(19)) || 0
    const promocodeCode = col(16)
    const promocodeDiscount = parseFloat(col(17)) || 0

    const order: Order & { sheetStatus: string; adminNote: string } = {
      orderId,
      status: (sheetStatus as OrderStatus) || 'pending',
      sheetStatus,
      adminNote: col(22),
      createdAt: col(1) ? new Date(col(1)).getTime() : Date.now(),
      updatedAt: col(2) ? new Date(col(2)).getTime() : Date.now(),
      customerChatId: col(5) || null,
      customerName: col(6) || null,
      platform: (col(4) as Platform) || 'telegram',
      cdekUuid: col(23) || null,
      cdekTrackNumber: col(24) || null,
      pochtaShpi: col(26) || null,
      orderData: {
        items,
        fullName: col(7),
        phone: col(8),
        username: col(9) || undefined,
        country: col(10),
        city: col(11),
        address: col(12),
        deliveryRegion: col(13),
        deliveryCost,
        deliveryMethod: (col(25) as DeliveryMethod) || undefined,
        total,
        comments: col(21) || undefined,
        priorityOrder: priorityOrder || undefined,
        priorityFee: priorityFee > 0 ? priorityFee : undefined,
        promocode: promocodeCode
          ? {
              code: promocodeCode,
              type: 'amount', // тип неизвестен после рестарта, но для уведомлений не критичен
              value: promocodeDiscount,
              discount: promocodeDiscount,
            }
          : undefined,
      },
    }

    logger.info({ orderId, sheetStatus, itemsCount: items.length }, 'getOrderFromSheet: заказ восстановлен из Sheets')
    return order
  } catch (e: any) {
    logger.warn({ orderId, error: e?.message }, 'getOrderFromSheet: ошибка чтения заказа из Sheets')
    return null
  }
}

export type OrderSummary = {
  orderId: string
  createdAt: string
  status: string
  total: number
  platform: string
}

/**
 * Возвращает последние `limit` заказов пользователя по customer_chat_id из Google Sheets.
 * Используется для команды /myorders в боте.
 */
export async function getOrdersByCustomerChatId(chatId: string, limit = 10): Promise<OrderSummary[]> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return []
  try {
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })
    const res = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDERS_SHEET}!A:U` // A(order_id) … U(total), F(customer_chat_id)=col5
    })
    const rows = res.data.values || []
    const results: OrderSummary[] = []
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as string[]
      if (!row || row[5] !== chatId) continue
      results.push({
        orderId: row[0] ?? '',
        createdAt: row[1] ?? '',
        status: row[3] ?? '',
        platform: row[4] ?? 'telegram',
        total: parseFloat(row[20]) || 0,
      })
    }
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return results.slice(0, limit)
  } catch (e: any) {
    logger.warn({ chatId, error: e?.message }, 'getOrdersByCustomerChatId: ошибка чтения из Sheets')
    return []
  }
}

export type OrderHistoryItem = {
  title: string
  price: number
  quantity: number
  option?: string
}

export type OrderHistoryEntry = {
  orderId: string
  createdAt: string
  status: string
  total: number
  deliveryMethod: string
  trackNumber: string | null
  trackUrl: string | null
  /** статус для покупателя: Принят / В сборке / В пути / Уже у вас; '' если ещё не проставлен */
  orderStatus: string
  items: OrderHistoryItem[]
}

/**
 * Отправлен ли заказ — по данным, которые уже лежат в Sheets, без обращений к СДЭКу.
 *
 * Признак отправки — флаг `shipped_notified` в admin_note: его ставит вебхук СДЭКа
 * на статусе RECEIVED_AT_SENDER_CITY (для EMS — менеджер вручную из админки).
 *
 * Для EMS возвращаем false намеренно: там флаг зависит от того, нажал ли менеджер
 * отбивку, то есть статус был бы недостоверным. Международных заказов немного, и у их
 * покупателей обычно все заказы EMS — расхождения они не увидят.
 *
 * Пустой deliveryMethod у старых заказов (колонка появилась позже) трактуем как СДЭК,
 * если проставлен cdek-трек.
 *
 * ВНИМАНИЕ: «доставлен» в системе не существует — вебхук DELIVERED мы не обрабатываем.
 * Поэтому отправленный заказ остаётся «отправлен» навсегда, в том числе давно полученный.
 */
export function isOrderShipped(deliveryMethod: string, cdekTrack: string, adminNote: string): boolean {
  if (deliveryMethod === 'ems') return false
  if (!cdekTrack) return false
  return adminNote.includes('shipped_notified')
}

export type OrderHistoryResult = {
  orders: OrderHistoryEntry[]
  /** всего оплаченных заказов — по ВСЕМ строкам, не по отданной странице */
  totalOrders: number
  /** дата самого первого заказа (для «с нами с …»), ISO; null если заказов нет */
  firstOrderAt: string | null
}

/**
 * История заказов покупателя для личного кабинета в мини-аппе.
 *
 * Отличается от `getOrdersByCustomerChatId` (та обслуживает /myorders в боте и намеренно
 * оставлена нетронутой): здесь нужен более широкий диапазон — до AB, потому что трек-номера
 * живут в колонках Y (СДЭК) и AA (ЕМС), а `A:U` обрывается на total — плюс состав заказа
 * из отдельного листа order_items.
 *
 * Показываем только оплаченные: строки `pending` — это в основном брошенные корзины,
 * покупателю они не «заказы».
 *
 * ВНИМАНИЕ: два полных чтения листов на вызов, фильтрация линейным сканом. Пока ЛК
 * открыт только админам (гейт в эндпойнте) — это несколько запросов в день. Перед
 * открытием на всех пользователей обязателен кэш, иначе выжжем квоту Sheets API.
 */
export async function getOrderHistoryByChatId(chatId: string, limit = 20): Promise<OrderHistoryResult> {
  const spreadsheetId = getSheetId()
  // не сконфигурирован лист — это поломка окружения, а не «нет заказов»
  if (!spreadsheetId) throw new Error('IMPORT_SHEET_ID not set')
  try {
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })
    const [ordersRes, itemsRes] = await Promise.all([
      api.spreadsheets.values.get({ spreadsheetId, range: `${ORDERS_SHEET}!A:AC` }),
      api.spreadsheets.values.get({ spreadsheetId, range: `${ORDER_ITEMS_SHEET}!A:H` }),
    ])

    const orderRows = ordersRes.data.values || []
    const itemRows = itemsRes.data.values || []

    // сначала отбираем свои заказы, только потом собираем позиции — чтобы не строить
    // индекс по всему листу order_items ради двух-трёх заказов
    const mine: string[][] = []
    for (let i = 1; i < orderRows.length; i++) {
      const row = orderRows[i] as string[]
      if (!row || row[5] !== chatId) continue
      if (row[3] !== 'paid') continue
      mine.push(row)
    }
    mine.sort((a, b) => new Date(b[1] ?? '').getTime() - new Date(a[1] ?? '').getTime())
    const page = mine.slice(0, limit)
    const wanted = new Set(page.map(row => row[0]))

    const itemsByOrder = new Map<string, OrderHistoryItem[]>()
    for (let i = 1; i < itemRows.length; i++) {
      const row = itemRows[i] as string[]
      const oid = row?.[0]
      if (!oid || !wanted.has(oid)) continue
      const bucket = itemsByOrder.get(oid) ?? []
      bucket.push({
        title: row[2] ?? '',
        price: parseFloat(row[3]) || 0,
        quantity: parseInt(row[4], 10) || 1,
        option: row[7] || undefined,
      })
      itemsByOrder.set(oid, bucket)
    }

    const orders = page.map(row => {
      const orderId = row[0] ?? ''
      const deliveryMethod = row[25] ?? ''
      const cdekTrack = row[24] || ''
      const emsTrack = row[26] || ''
      const trackNumber = (deliveryMethod === 'ems' ? emsTrack : cdekTrack) || null
      // формат ссылок тот же, что в отбивках покупателю (server.ts) — расхождение сбивало бы с толку
      const trackUrl = !trackNumber
        ? null
        : deliveryMethod === 'ems'
          ? `https://www.pochta.ru/tracking#${trackNumber}`
          : `https://cdek.ru/m/order/${trackNumber}`
      return {
        orderId,
        createdAt: row[1] ?? '',
        status: row[3] ?? '',
        total: parseFloat(row[20]) || 0,
        deliveryMethod,
        trackNumber,
        trackUrl,
        // фолбэк на shipped_notified в admin_note (колонка W) нужен для заказов,
        // оплаченных ДО появления колонки order_status: у них она пустая навсегда,
        // но факт отправки в admin_note записан
        orderStatus: row[ORDER_STATUS_INDEX] || (isOrderShipped(deliveryMethod, cdekTrack, row[22] ?? '') ? 'В пути' : ''),
        items: itemsByOrder.get(orderId) ?? [],
      }
    })

    // счётчик и «с нами с …» считаем по ВСЕМ заказам, а не по отданной странице:
    // иначе у покупателя с 25 заказами цифры молча врали бы, оставаясь правдоподобными.
    // mine отсортирован по убыванию даты, поэтому самый первый заказ — последний элемент.
    return {
      orders,
      totalOrders: mine.length,
      firstOrderAt: mine.length > 0 ? (mine[mine.length - 1][1] ?? null) : null,
    }
  } catch (e: any) {
    // НЕ отдаём пустую историю: «заказов нет» и «Sheets не ответил» выглядели бы для
    // покупателя одинаково, и покупатель с десятью заказами увидел бы пустой ЛК как
    // штатное состояние. Пробрасываем — эндпойнт превратит это в 500, алерт и явную
    // ошибку на экране.
    logger.error({ chatId, error: e?.message }, 'getOrderHistoryByChatId: ошибка чтения из Sheets')
    throw e
  }
}

/**
 * Двигает статус заказа вперёд. Назад не откатывает НИКОГДА.
 *
 * Зачем: источников два и они независимы. Менеджер в amoCRM может передвинуть сделку
 * обратно в «В работе» уже после того, как СДЭК прислал доставку, а вебхуки вообще
 * приходят в произвольном порядке (ретраи, Render поспал, ночной синк догоняет).
 * Без этого правила покупатель видел бы, как заказ «разъезжается» назад.
 *
 * Возвращает true, если значение реально изменилось.
 */
export async function advanceOrderStatusInSheet(orderId: string, next: OrderCustomerStatus): Promise<boolean> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return false
  if (statusRank(next) < 0) return false
  // через очередь: вебхуки приходят пачками, а у Sheets лимит на запись
  return queueStatusWrite(() => writeOrderStatus(spreadsheetId, orderId, next))
}

async function writeOrderStatus(spreadsheetId: string, orderId: string, next: OrderCustomerStatus): Promise<boolean> {
  try {
    await ensureOrderSheets()
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })

    // один запрос вместо трёх: номера заказов, способ доставки и текущие статусы
    const res = await api.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [
        `${ORDERS_SHEET}!A:A`,
        `${ORDERS_SHEET}!${DELIVERY_METHOD_COL}:${DELIVERY_METHOD_COL}`,
        `${ORDERS_SHEET}!${ORDER_STATUS_COL}:${ORDER_STATUS_COL}`,
      ],
    })
    const idRows = res.data.valueRanges?.[0]?.values || []
    const deliveryRows = res.data.valueRanges?.[1]?.values || []
    const statusRows = res.data.valueRanges?.[2]?.values || []

    let rowNumber = -1
    for (let i = 1; i < idRows.length; i++) {
      if (idRows[i]?.[0] === orderId) { rowNumber = i + 1; break }
    }
    if (rowNumber === -1) {
      logger.info({ orderId, next }, 'advanceOrderStatus: заказ не найден в Sheets — пропускаем')
      return false
    }

    // EMS не доезжает до «Уже у вас» — его конечная метка «Отправлен»
    const deliveryMethod = deliveryRows[rowNumber - 1]?.[0] ?? ''
    const label = labelForDelivery(next, deliveryMethod)

    const current = statusRows[rowNumber - 1]?.[0] ?? ''
    if (statusRank(current) >= statusRank(label)) {
      logger.info({ orderId, current, next: label }, 'advanceOrderStatus: статус не двигается назад — пропускаем')
      return false
    }

    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${ORDERS_SHEET}!${ORDER_STATUS_COL}${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[label]] },
    })
    logger.info({ orderId, from: current || '—', to: label, rowNumber }, 'advanceOrderStatus: статус обновлён')
    return true
  } catch (e: any) {
    logger.error({ orderId, next, error: e?.message }, 'advanceOrderStatus: ошибка записи в Sheets')
    // Молчать тут нельзя: при сбое Sheets статус просто застынет, покупатель будет
    // видеть неправильную стадию, и заметить это без алерта невозможно — в отличие
    // от заказа или оплаты, у статуса нет второго пути восстановления.
    sendAlert(
      `Статус заказа ${orderId} не обновлён на «${next}»: ${e?.message}`,
      {
        tag: 'orders', level: 'moderate',
        hint: 'покупатель видит устаревший статус в ЛК; при частых срабатываниях — проверьте квоту Sheets',
        code: 'ORDER_STATUS_WRITE_FAILED',
      }
    ).catch(() => {})
    return false
  }
}

export async function updateCdekInfoInSheet(orderId: string, cdekUuid: string, cdekTrackNumber: string | null): Promise<void> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return
  try {
    await ensureOrderSheets()
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })
    const res = await api.spreadsheets.values.get({ spreadsheetId, range: `${ORDERS_SHEET}!A:A` })
    const rows = res.data.values || []
    let rowNumber = -1
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]?.[0] === orderId) { rowNumber = i + 1; break }
    }
    if (rowNumber === -1) {
      logger.warn({ orderId }, 'updateCdekInfoInSheet: строка не найдена')
      return
    }
    // columns X=24 (cdek_uuid), Y=25 (cdek_track_number)
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${ORDERS_SHEET}!X${rowNumber}:Y${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[cdekUuid, cdekTrackNumber ?? '']] }
    })
    logger.info({ orderId, cdekUuid, cdekTrackNumber, rowNumber }, 'CDEK info обновлён в Google Sheets')
  } catch (e: any) {
    logger.warn({ orderId, error: e?.message }, 'updateCdekInfoInSheet: ошибка')
  }
}

/** Записывает ШПИ (трек EMS Почты России) в колонку pochta_shpi (AA). */
export async function updatePochtaInfoInSheet(orderId: string, shpi: string): Promise<void> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return
  try {
    await ensureOrderSheets()
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })
    const res = await api.spreadsheets.values.get({ spreadsheetId, range: `${ORDERS_SHEET}!A:A` })
    const rows = res.data.values || []
    let rowNumber = -1
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]?.[0] === orderId) { rowNumber = i + 1; break }
    }
    if (rowNumber === -1) {
      logger.warn({ orderId }, 'updatePochtaInfoInSheet: строка не найдена')
      return
    }
    // column AA=27 (pochta_shpi)
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${ORDERS_SHEET}!AA${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[shpi]] }
    })
    logger.info({ orderId, shpi, rowNumber }, 'Pochta ШПИ обновлён в Google Sheets')
  } catch (e: any) {
    logger.warn({ orderId, error: e?.message }, 'updatePochtaInfoInSheet: ошибка')
  }
}

export async function updateOrderAdminNoteInSheet(orderId: string, note: string): Promise<void> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return
  try {
    await ensureOrderSheets()
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })
    const res = await api.spreadsheets.values.get({ spreadsheetId, range: `${ORDERS_SHEET}!A:A` })
    const rows = res.data.values || []
    let rowNumber = -1
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]?.[0] === orderId) { rowNumber = i + 1; break }
    }
    if (rowNumber === -1) {
      logger.warn({ orderId }, 'updateOrderAdminNoteInSheet: строка не найдена')
      return
    }
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${ORDERS_SHEET}!W${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[note]] }
    })
    logger.info({ orderId, rowNumber }, 'admin_note обновлён в Google Sheets')
  } catch (e: any) {
    logger.warn({ orderId, error: e?.message }, 'updateOrderAdminNoteInSheet: ошибка')
  }
}

/**
 * Читает все pending-заказы из Sheets в заданном возрастном окне.
 * Используется при старте сервера для восстановления в памяти заказов,
 * созданных до рестарта (чтобы polling мог их проверить через Robokassa).
 * Делает ровно 2 запроса к Sheets API независимо от числа заказов.
 */
export async function listPendingOrdersFromSheet(
  minAgeMs: number,
  maxAgeMs: number
): Promise<Order[]> {
  const spreadsheetId = getSheetId()
  if (!spreadsheetId) return []
  try {
    const auth = getAuth()
    const api = google.sheets({ version: 'v4', auth })
    const now = Date.now()

    const ordersRes = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDERS_SHEET}!A:Y`
    })
    const orderRows = ordersRes.data.values || []

    const candidateIds: string[] = []
    const rowByOrderId = new Map<string, string[]>()

    for (let i = 1; i < orderRows.length; i++) {
      const row = orderRows[i] as string[]
      if (!row?.[0] || row[3] !== 'pending') continue
      const createdAt = row[1] ? new Date(row[1]).getTime() : 0
      const age = now - createdAt
      if (age < minAgeMs || age > maxAgeMs) continue
      candidateIds.push(row[0])
      rowByOrderId.set(row[0], row)
    }

    if (candidateIds.length === 0) return []

    const itemsRes = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDER_ITEMS_SHEET}!A:H`
    })
    const itemRows = itemsRes.data.values || []

    const itemsByOrderId = new Map<string, Order['orderData']['items']>()
    for (let i = 1; i < itemRows.length; i++) {
      const row = itemRows[i] as string[]
      if (!row?.[0] || !candidateIds.includes(row[0])) continue
      const bucket = itemsByOrderId.get(row[0]) ?? []
      bucket.push({
        slug: row[1] ?? '',
        title: row[2] ?? '',
        price: parseFloat(row[3]) || 0,
        quantity: parseInt(row[4], 10) || 1,
        article: row[5] || undefined,
        option: row[7] || undefined,
      })
      itemsByOrderId.set(row[0], bucket)
    }

    const result: Order[] = []
    for (const orderId of candidateIds) {
      const row = rowByOrderId.get(orderId)!
      const col = (i: number) => row[i] ?? ''
      const items = itemsByOrderId.get(orderId) ?? []
      if (items.length === 0) continue

      const promocodeCode = col(16)
      const promocodeDiscount = parseFloat(col(17)) || 0
      const priorityFee = parseFloat(col(19)) || 0

      result.push({
        orderId,
        status: 'pending',
        createdAt: col(1) ? new Date(col(1)).getTime() : now,
        updatedAt: col(2) ? new Date(col(2)).getTime() : now,
        customerChatId: col(5) || null,
        customerName: col(6) || null,
        platform: (col(4) as Platform) || 'telegram',
        orderData: {
          items,
          fullName: col(7),
          phone: col(8),
          username: col(9) || undefined,
          country: col(10),
          city: col(11),
          address: col(12),
          deliveryRegion: col(13),
          deliveryCost: parseFloat(col(14)) || 0,
          deliveryMethod: (col(25) as DeliveryMethod) || undefined,
          total: parseFloat(col(20)) || 0,
          comments: col(21) || undefined,
          priorityOrder: col(18) === 'true' || undefined,
          priorityFee: priorityFee > 0 ? priorityFee : undefined,
          promocode: promocodeCode
            ? { code: promocodeCode, type: 'amount', value: promocodeDiscount, discount: promocodeDiscount }
            : undefined,
        },
      })
    }

    logger.info({ count: result.length }, 'listPendingOrdersFromSheet: найдено pending заказов в Sheets')
    return result
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'listPendingOrdersFromSheet: ошибка чтения из Sheets')
    return []
  }
}
