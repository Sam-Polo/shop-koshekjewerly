import { google } from 'googleapis'
import fs from 'node:fs'
import pino from 'pino'

const logger = pino()

const SHEET_NAME = 'shipment_items'

type ShipStatus = 'pending' | 'sent' | 'returned'
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
  sent: number
  returned: number
}

export type ShipmentsReport = {
  summary: ShipmentSummaryItem[]
  bySource: Record<string, { pending: number; sent: number }>
  totals: { pending: number; sent: number; returned: number }
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

async function readShipmentRows(): Promise<ShipmentRow[]> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${SHEET_NAME}!A:G`,
  })
  const rows = (res.data.values ?? []).slice(1)
  return rows
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
}

/** Reads article→title map from all category sheets. */
async function readArticleTitleMap(): Promise<Map<string, string>> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = getSpreadsheetId()

  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const sheetTitles = (meta.data.sheets ?? [])
    .map(s => s.properties?.title ?? '')
    .filter(t => t && t !== SHEET_NAME && !t.startsWith('order') && t !== 'categories')

  const articleMap = new Map<string, string>()

  for (const sheetTitle of sheetTitles) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetTitle}!A1:K1000`,
      })
      const rows = res.data.values ?? []
      if (rows.length < 2) continue
      const header = rows[0].map((h: string) => h.trim().toLowerCase())
      const articleIdx = header.indexOf('article')
      const titleIdx = header.indexOf('title')
      if (articleIdx === -1 || titleIdx === -1) continue
      for (let i = 1; i < rows.length; i++) {
        const article = String(rows[i][articleIdx] ?? '').trim()
        const title = String(rows[i][titleIdx] ?? '').trim()
        if (article && title) articleMap.set(article, title)
      }
    } catch (e: any) {
      logger.warn({ sheetTitle, err: e?.message }, 'skip sheet when building article map')
    }
  }

  return articleMap
}

export async function buildShipmentsReport(opts: {
  from?: string  // YYYY-MM-DD inclusive
  to?: string    // YYYY-MM-DD inclusive
  source?: string
}): Promise<ShipmentsReport> {
  const [rows, articleMap] = await Promise.all([
    readShipmentRows(),
    readArticleTitleMap(),
  ])

  const filtered = rows.filter(r => {
    if (opts.source && r.source !== opts.source) return false
    if (opts.from && r.order_date < opts.from) return false
    if (opts.to && r.order_date > opts.to) return false
    return true
  })

  // aggregate by article
  const byArticle = new Map<string, ShipmentSummaryItem>()
  const bySource: Record<string, { pending: number; sent: number }> = {}

  for (const row of filtered) {
    if (!row.article) continue

    let entry = byArticle.get(row.article)
    if (!entry) {
      entry = {
        article: row.article,
        title: articleMap.get(row.article) ?? '',
        pending: 0,
        sent: 0,
        returned: 0,
      }
      byArticle.set(row.article, entry)
    }

    if (row.ship_status === 'pending') entry.pending += row.qty
    else if (row.ship_status === 'sent') entry.sent += row.qty
    else if (row.ship_status === 'returned') entry.returned += row.qty

    // by source (pending + sent only)
    if (row.ship_status === 'pending' || row.ship_status === 'sent') {
      if (!bySource[row.source]) bySource[row.source] = { pending: 0, sent: 0 }
      if (row.ship_status === 'pending') bySource[row.source].pending += row.qty
      else bySource[row.source].sent += row.qty
    }
  }

  // sort: articles with most pending first
  const summary = [...byArticle.values()].sort((a, b) => b.pending - a.pending)

  const totals = summary.reduce(
    (acc, s) => ({ pending: acc.pending + s.pending, sent: acc.sent + s.sent, returned: acc.returned + s.returned }),
    { pending: 0, sent: 0, returned: 0 }
  )

  return { summary, bySource, totals }
}
