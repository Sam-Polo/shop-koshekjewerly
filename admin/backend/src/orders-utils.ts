import { google } from 'googleapis'
import fs from 'node:fs'
import pino from 'pino'

const logger = pino()

const ORDERS_SHEET = 'orders'
const ORDER_ITEMS_SHEET = 'order_items'

export type OrderRow = {
  rowNumber: number
  orderId: string
  createdAt: string
  updatedAt: string
  status: string
  platform: string
  customerChatId: string
  customerName: string
  fullName: string
  phone: string
  username: string
  country: string
  city: string
  address: string
  deliveryRegion: string
  deliveryCost: number
  itemsTotal: number
  promocodeCode: string
  promocodeDiscount: number
  priorityOrder: boolean
  priorityFee: number
  total: number
  clientComment: string
  adminNote: string
  cdekTrackNumber: string
  deliveryMethod: string
  pochtaShpi: string
}

export type OrderItemRow = {
  orderId: string
  slug: string
  title: string
  price: number
  quantity: number
  article: string
  category: string
}

export type FullOrder = OrderRow & {
  items: OrderItemRow[]
}

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

function toNum(v: any): number {
  if (v == null || v === '') return 0
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

function toBool(v: any): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

function parseOrderRow(row: any[], rowNumber: number): OrderRow | null {
  const orderId = String(row[0] || '').trim()
  if (!orderId) return null
  return {
    rowNumber,
    orderId,
    createdAt: String(row[1] || ''),
    updatedAt: String(row[2] || ''),
    status: String(row[3] || ''),
    platform: String(row[4] || ''),
    customerChatId: String(row[5] || ''),
    customerName: String(row[6] || ''),
    fullName: String(row[7] || ''),
    phone: String(row[8] || ''),
    username: String(row[9] || ''),
    country: String(row[10] || ''),
    city: String(row[11] || ''),
    address: String(row[12] || ''),
    deliveryRegion: String(row[13] || ''),
    deliveryCost: toNum(row[14]),
    itemsTotal: toNum(row[15]),
    promocodeCode: String(row[16] || ''),
    promocodeDiscount: toNum(row[17]),
    priorityOrder: toBool(row[18]),
    priorityFee: toNum(row[19]),
    total: toNum(row[20]),
    clientComment: String(row[21] || ''),
    adminNote: String(row[22] || ''),
    cdekTrackNumber: String(row[24] || ''),
    deliveryMethod: String(row[25] || ''),
    pochtaShpi: String(row[26] || ''),
  }
}

function parseItemRow(row: any[]): OrderItemRow | null {
  const orderId = String(row[0] || '').trim()
  if (!orderId) return null
  return {
    orderId,
    slug: String(row[1] || ''),
    title: String(row[2] || ''),
    price: toNum(row[3]),
    quantity: toNum(row[4]),
    article: String(row[5] || ''),
    category: String(row[6] || ''),
  }
}

const CACHE_TTL_MS = 30_000
type CacheEntry = { orders: OrderRow[]; items: OrderItemRow[]; ts: number }
let cache: CacheEntry | null = null

export function invalidateOrdersCache() {
  cache = null
}

export async function loadAllOrders(): Promise<{ orders: OrderRow[]; items: OrderItemRow[] }> {
  const now = Date.now()
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return { orders: cache.orders, items: cache.items }
  }
  const sheetId = process.env.GOOGLE_SHEET_ID
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID not configured')

  const auth = getAuth()
  const api = google.sheets({ version: 'v4', auth })

  let ordersData: any[][] = []
  let itemsData: any[][] = []

  try {
    const res = await api.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges: [`${ORDERS_SHEET}!A2:AA10000`, `${ORDER_ITEMS_SHEET}!A2:G50000`]
    })
    ordersData = res.data.valueRanges?.[0]?.values || []
    itemsData = res.data.valueRanges?.[1]?.values || []
  } catch (e: any) {
    // листов может ещё не быть — пустой массив
    logger.warn({ error: e?.message }, 'не удалось прочитать листы orders/order_items')
  }

  const orders: OrderRow[] = []
  ordersData.forEach((row, i) => {
    const parsed = parseOrderRow(row, i + 2)
    if (parsed) orders.push(parsed)
  })

  const items: OrderItemRow[] = []
  itemsData.forEach((row) => {
    const parsed = parseItemRow(row)
    if (parsed) items.push(parsed)
  })

  cache = { orders, items, ts: now }
  return { orders, items }
}

export async function loadFullOrders(): Promise<FullOrder[]> {
  const { orders, items } = await loadAllOrders()
  const byOrder = new Map<string, OrderItemRow[]>()
  for (const it of items) {
    if (!byOrder.has(it.orderId)) byOrder.set(it.orderId, [])
    byOrder.get(it.orderId)!.push(it)
  }
  return orders.map(o => ({ ...o, items: byOrder.get(o.orderId) || [] }))
}

export async function updateOrderNote(orderId: string, note: string): Promise<boolean> {
  const sheetId = process.env.GOOGLE_SHEET_ID
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID not configured')
  const { orders } = await loadAllOrders()
  const order = orders.find(o => o.orderId === orderId)
  if (!order) return false
  const auth = getAuth()
  const api = google.sheets({ version: 'v4', auth })
  // колонка W (23) — admin_note
  await api.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${ORDERS_SHEET}!W${order.rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[note]] }
  })
  invalidateOrdersCache()
  return true
}
