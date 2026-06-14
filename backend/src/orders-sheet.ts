import { google } from 'googleapis'
import fs from 'node:fs'
import pino from 'pino'
import type { Order, OrderStatus, Platform, DeliveryMethod } from './orders.js'
import { listProducts } from './store.js'
import { sendAlert } from './alerts.js'

const logger = pino()

const ORDERS_SHEET = 'orders'
const ORDER_ITEMS_SHEET = 'order_items'

const ORDERS_HEADERS = [
  'order_id', 'created_at', 'updated_at', 'status', 'platform',
  'customer_chat_id', 'customer_name', 'full_name', 'phone', 'username',
  'country', 'city', 'address', 'delivery_region', 'delivery_cost',
  'items_total', 'promocode_code', 'promocode_discount',
  'priority_order', 'priority_fee', 'total', 'client_comment', 'admin_note',
  'cdek_uuid', 'cdek_track_number', 'delivery_method', 'pochta_shpi'
]

const ORDER_ITEMS_HEADERS = [
  'order_id', 'slug', 'title', 'price', 'quantity', 'article', 'category'
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
    resolveItemCategory(it.slug)
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
        range: `${ORDER_ITEMS_SHEET}!A:G`,
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
    const ordersRes = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDERS_SHEET}!A:Y`
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
    // 0=order_id, 1=slug, 2=title, 3=price, 4=quantity, 5=article, 6=category
    const itemsRes = await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDER_ITEMS_SHEET}!A:G`
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
      range: `${ORDER_ITEMS_SHEET}!A:G`
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
