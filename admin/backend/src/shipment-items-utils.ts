import { google } from 'googleapis'
import fs from 'node:fs'
import pino from 'pino'
import { fetchProductsFromSheet } from './sheets.js'

const logger = pino()

const SHEET_NAME = 'shipment_items'

function normalizeArticle(article: string): string {
  return /^\d+$/.test(article) ? article.padStart(4, '0') : article
}

// In-memory cache — avoids hitting Google Sheets on every filter/nav change
const ROWS_TTL   = 30_000   // 30s
const TITLES_TTL = 300_000  // 5 min (product catalog changes rarely)

let rowsCache:   { data: ShipmentRow[];       at: number } | null = null
let titlesCache: { data: Map<string, string>; at: number } | null = null

export function invalidateShipmentsCache() {
  rowsCache   = null
  titlesCache = null
}

type ShipStatus = 'pending' | 'in_work' | 'assembled' | 'sent' | 'returned'
type ShipSource = 'telegram' | 'tilda' | 'max'

type ShipmentRow = {
  order_id: string
  source: ShipSource
  article: string
  qty: number
  order_date: string   // YYYY-MM-DD
  ship_status: ShipStatus
  ship_date: string
}

export type ShipmentSummaryItem = {
  article: string
  title: string        // from product catalog, empty if article not found
  pending: number
  in_work: number
  assembled: number
  sent: number
  returned: number
}

export type ShipmentsReport = {
  summary: ShipmentSummaryItem[]
  bySource: Record<string, { pending: number; in_work: number; assembled: number; sent: number }>
  totals: { pending: number; in_work: number; assembled: number; sent: number; returned: number }
}

function getAuth() {
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  let creds: any
  if (filePath) creds = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  else if (raw) creds = JSON.parse(raw)
  else throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE required')
  return new google.auth.JWT(
    creds.client_email, undefined, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  )
}

function getSpreadsheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID
  if (!id) throw new Error('GOOGLE_SHEET_ID not set')
  return id
}

async function readShipmentRows(nocache = false): Promise<ShipmentRow[]> {
  const now = Date.now()
  if (!nocache && rowsCache && (now - rowsCache.at) < ROWS_TTL) {
    logger.debug('shipment rows: cache hit')
    return rowsCache.data
  }
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${SHEET_NAME}!A:G`,
  })
  const rows = (res.data.values ?? []).slice(1)
  const data = rows
    .filter(r => r[0])
    .map(r => ({
      order_id:    String(r[0] ?? ''),
      source:      (r[1] ?? 'telegram') as ShipSource,
      article:     String(r[2] ?? ''),
      qty:         parseInt(r[3] ?? '1', 10) || 1,
      order_date:  String(r[4] ?? ''),
      ship_status: (r[5] ?? 'pending') as ShipStatus,
      ship_date:   String(r[6] ?? ''),
    }))
  rowsCache = { data, at: now }
  return data
}

async function readArticleTitleMap(nocache = false): Promise<Map<string, string>> {
  const now = Date.now()
  if (!nocache && titlesCache && (now - titlesCache.at) < TITLES_TTL) {
    logger.debug('article titles: cache hit')
    return titlesCache.data
  }
  const products = await fetchProductsFromSheet(getSpreadsheetId())
  const map = new Map<string, string>()
  for (const p of products) {
    if (p.article && p.title) map.set(normalizeArticle(p.article), p.title)
  }
  titlesCache = { data: map, at: now }
  return map
}

export async function buildShipmentsReport(opts: {
  from?: string  // YYYY-MM-DD inclusive
  to?: string    // YYYY-MM-DD inclusive
  source?: string
  nocache?: boolean
}): Promise<ShipmentsReport> {
  const [rows, articleMap] = await Promise.all([
    readShipmentRows(opts.nocache),
    readArticleTitleMap(opts.nocache),
  ])

  const filtered = rows.filter(r => {
    if (opts.source && r.source !== opts.source) return false
    if (opts.from && r.order_date < opts.from) return false
    if (opts.to && r.order_date > opts.to) return false
    return true
  })

  // aggregate by article
  const byArticle = new Map<string, ShipmentSummaryItem>()
  const bySource: Record<string, { pending: number; in_work: number; assembled: number; sent: number }> = {}

  for (const row of filtered) {
    if (!row.article) continue

    let entry = byArticle.get(row.article)
    if (!entry) {
      entry = {
        article: row.article,
        title: articleMap.get(row.article) ?? '',
        pending: 0,
        in_work: 0,
        assembled: 0,
        sent: 0,
        returned: 0,
      }
      byArticle.set(row.article, entry)
    }

    if (row.ship_status === 'pending')   entry.pending   += row.qty
    else if (row.ship_status === 'in_work')   entry.in_work   += row.qty
    else if (row.ship_status === 'assembled') entry.assembled += row.qty
    else if (row.ship_status === 'sent')     entry.sent      += row.qty
    else if (row.ship_status === 'returned') entry.returned  += row.qty

    // by source (active orders: pending + in_work + assembled + sent)
    const activeStatuses = ['pending', 'in_work', 'assembled', 'sent'] as const
    if ((activeStatuses as readonly string[]).includes(row.ship_status)) {
      if (!bySource[row.source]) bySource[row.source] = { pending: 0, in_work: 0, assembled: 0, sent: 0 }
      const src = bySource[row.source]
      if (row.ship_status === 'pending')   src.pending   += row.qty
      else if (row.ship_status === 'in_work')   src.in_work   += row.qty
      else if (row.ship_status === 'assembled') src.assembled += row.qty
      else if (row.ship_status === 'sent')      src.sent      += row.qty
    }
  }

  // sort: articles with most active (pending+in_work+assembled) first
  const summary = [...byArticle.values()].sort(
    (a, b) => (b.pending + b.in_work + b.assembled) - (a.pending + a.in_work + a.assembled)
  )

  const totals = summary.reduce(
    (acc, s) => ({
      pending:   acc.pending   + s.pending,
      in_work:   acc.in_work   + s.in_work,
      assembled: acc.assembled + s.assembled,
      sent:      acc.sent      + s.sent,
      returned:  acc.returned  + s.returned,
    }),
    { pending: 0, in_work: 0, assembled: 0, sent: 0, returned: 0 }
  )

  return { summary, bySource, totals }
}
