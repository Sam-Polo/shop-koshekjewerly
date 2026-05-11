import { google } from 'googleapis'
import fs from 'node:fs'
import pino from 'pino'
import type { Order } from './orders.js'
import { listProducts } from './store.js'

const logger = pino()

const ORDERS_SHEET = 'orders'
const ORDER_ITEMS_SHEET = 'order_items'

const ORDERS_HEADERS = [
  'order_id', 'created_at', 'updated_at', 'status', 'platform',
  'customer_chat_id', 'customer_name', 'full_name', 'phone', 'username',
  'country', 'city', 'address', 'delivery_region', 'delivery_cost',
  'items_total', 'promocode_code', 'promocode_discount',
  'priority_order', 'priority_fee', 'total', 'client_comment', 'admin_note'
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
      range: `${sheetName}!A1:${String.fromCharCode(64 + headers.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    })
    logger.info({ sheetName }, 'лист создан')
    return
  }
  const range = `${sheetName}!A1:${String.fromCharCode(64 + headers.length)}1`
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
    '' // admin_note
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
      range: `${ORDERS_SHEET}!A:W`,
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
    logger.warn({ orderId, error: e?.message }, 'не удалось обновить статус заказа в Google Sheets')
  }
}
