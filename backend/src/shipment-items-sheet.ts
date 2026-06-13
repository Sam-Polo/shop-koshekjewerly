import { google } from 'googleapis'
import fs from 'node:fs'

export type ShipStatus = 'pending' | 'sent' | 'returned'
export type ShipSource = 'telegram' | 'tilda' | 'max'

export type ShipmentItem = {
  order_id: string
  source: ShipSource
  article: string
  qty: number
  order_date: string   // ISO date string, e.g. "2026-06-14"
  ship_status: ShipStatus
  ship_date: string    // ISO date string, empty string if not shipped
}

const SHEET_NAME = 'shipment_items'
const HEADERS = ['order_id', 'source', 'article', 'qty', 'order_date', 'ship_status', 'ship_date']

function getAuth() {
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  let creds: any
  if (filePath) creds = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  else if (raw) creds = JSON.parse(raw)
  else throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE required')
  return new google.auth.JWT(
    creds.client_email, undefined, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  )
}

function getSheetId(): string {
  const id = process.env.SPREADSHEET_ID
  if (!id) throw new Error('SPREADSHEET_ID not set')
  return id
}

function rowToItem(row: string[]): ShipmentItem {
  return {
    order_id:    row[0] ?? '',
    source:      (row[1] ?? 'telegram') as ShipSource,
    article:     row[2] ?? '',
    qty:         parseInt(row[3] ?? '1', 10) || 1,
    order_date:  row[4] ?? '',
    ship_status: (row[5] ?? 'pending') as ShipStatus,
    ship_date:   row[6] ?? '',
  }
}

function itemToRow(item: ShipmentItem): string[] {
  return [
    item.order_id,
    item.source,
    item.article,
    String(item.qty),
    item.order_date,
    item.ship_status,
    item.ship_date,
  ]
}

/** Ensures the shipment_items sheet exists with headers. Idempotent. */
export async function ensureShipmentItemsSheet(): Promise<void> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = getSheetId()

  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const exists = meta.data.sheets?.some(s => s.properties?.title === SHEET_NAME)

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    })
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    })
  }
}

/** Appends one or more shipment item rows to the sheet. */
export async function appendShipmentItems(items: ShipmentItem[]): Promise<void> {
  if (items.length === 0) return
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSheetId(),
    range: `${SHEET_NAME}!A:G`,
    valueInputOption: 'RAW',
    requestBody: { values: items.map(itemToRow) },
  })
}

/** Reads all shipment items from the sheet. */
export async function readAllShipmentItems(): Promise<ShipmentItem[]> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: `${SHEET_NAME}!A:G`,
  })
  const rows = (res.data.values ?? []).slice(1) // skip header
  return rows.filter(r => r[0]).map(rowToItem)
}

/**
 * Marks all pending items for a given order_id as sent.
 * Called from the amoCRM stage-change webhook.
 */
export async function markOrderAsSent(orderId: string, shipDate: string): Promise<number> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = getSheetId()

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:G`,
  })
  const rows = res.data.values ?? []
  if (rows.length < 2) return 0

  // collect updates: rows where order_id matches and status is pending
  const updates: { row: number; values: string[] }[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (r[0] === orderId && (r[5] === 'pending' || !r[5])) {
      const updated = [...r]
      updated[5] = 'sent'
      updated[6] = shipDate
      // pad to 7 columns in case row is short
      while (updated.length < 7) updated.push('')
      updates.push({ row: i + 1, values: updated.slice(0, 7) })
    }
  }

  if (updates.length === 0) return 0

  // batch update all matching rows
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map(u => ({
        range: `${SHEET_NAME}!A${u.row}:G${u.row}`,
        values: [u.values],
      })),
    },
  })

  return updates.length
}
