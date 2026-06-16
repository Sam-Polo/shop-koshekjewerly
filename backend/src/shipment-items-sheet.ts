import { google } from 'googleapis'
import fs from 'node:fs'

export type ShipStatus = 'pending' | 'priority' | 'in_work' | 'assembled' | 'sent' | 'returned'
export type ShipSource = 'telegram' | 'tilda' | 'max'

export type ShipmentItem = {
  order_id: string
  source: ShipSource
  article: string
  qty: number
  order_date: string   // ISO date string, e.g. "2026-06-14"
  ship_status: ShipStatus
  ship_date: string    // ISO date string, empty string if not shipped
  title: string        // product name from composition text
  lead_id: string      // amoCRM lead ID, empty for tilda-webhook orders
}

const SHEET_NAME = 'shipment_items'
const HEADERS = ['order_id', 'source', 'article', 'qty', 'order_date', 'ship_status', 'ship_date', 'title', 'lead_id']

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
  const id = process.env.IMPORT_SHEET_ID
  if (!id) throw new Error('IMPORT_SHEET_ID not set')
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
    title:       row[7] ?? '',
    lead_id:     row[8] ?? '',
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
    item.title,
    item.lead_id,
  ]
}

/** Ensures the shipment_items sheet exists with headers. Always updates header row. */
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
  }
  // Always write header to keep schema current
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  })
}

/** Appends one or more shipment item rows to the sheet. */
export async function appendShipmentItems(items: ShipmentItem[]): Promise<void> {
  if (items.length === 0) return
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSheetId(),
    range: `${SHEET_NAME}!A:I`,
    valueInputOption: 'RAW',
    requestBody: { values: items.map(itemToRow) },
  })
}

/**
 * Creates order rows only if the order_id is not already in the sheet.
 * Used by tilda-webhook to avoid duplicates on retries or re-imports.
 */
export async function createOrderItemsIfNew(
  orderId: string,
  items: ShipmentItem[]
): Promise<'created' | 'noop'> {
  if (items.length === 0) return 'noop'
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = getSheetId()

  // read only column A to keep it cheap
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:A`,
  })
  const exists = (res.data.values ?? []).slice(1).some(r => r[0] === orderId)
  if (exists) return 'noop'

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_NAME}!A:I`,
    valueInputOption: 'RAW',
    requestBody: { values: items.map(itemToRow) },
  })
  return 'created'
}

/** Reads all shipment items from the sheet. */
export async function readAllShipmentItems(): Promise<ShipmentItem[]> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: `${SHEET_NAME}!A:I`,
  })
  const rows = (res.data.values ?? []).slice(1) // skip header
  return rows.filter(r => r[0]).map(rowToItem)
}

/**
 * For webhook upserts: if order_id already exists — update pending rows to new status.
 * If order_id is new — append the provided items.
 * Returns 'created' | 'updated' | 'noop'.
 */
export async function upsertOrderItems(
  orderId: string,
  newStatus: ShipStatus,
  items: ShipmentItem[],
  shipDate: string
): Promise<'created' | 'updated' | 'noop'> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = getSheetId()

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:I`,
  })
  const rows = res.data.values ?? []

  const orderRows = rows.slice(1).map((r, i) => ({ r, rowNum: i + 2 })).filter(({ r }) => r[0] === orderId)

  if (orderRows.length === 0) {
    // new order — append
    if (items.length === 0) return 'noop'
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:I`,
      valueInputOption: 'RAW',
      requestBody: { values: items.map(itemToRow) },
    })
    return 'created'
  }

  // existing order — update all rows to new status (backward moves allowed for corrections)
  const updates = orderRows
    .filter(({ r }) => r[5] !== newStatus)  // skip rows already at target status
    .map(({ r, rowNum }) => {
      const updated = [...r]
      updated[5] = newStatus
      updated[6] = (newStatus === 'sent' || newStatus === 'returned') ? shipDate : ''
      while (updated.length < 9) updated.push('')
      return { range: `${SHEET_NAME}!A${rowNum}:I${rowNum}`, values: [updated.slice(0, 9)] }
    })

  if (updates.length === 0) return 'noop'

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: updates },
  })
  return 'updated'
}

/**
 * Bulk version of upsertOrderItems for the nightly sync.
 * Reads the sheet ONCE, computes all changes in memory, then writes with a
 * single batchUpdate + single append — avoids the Google Sheets read quota
 * blowout of reading the whole sheet per lead.
 */
export async function bulkUpsertOrders(
  orders: { orderId: string; newStatus: ShipStatus; items: ShipmentItem[]; shipDate: string }[]
): Promise<{ created: number; updated: number; noop: number }> {
  const stats = { created: 0, updated: 0, noop: 0 }
  if (orders.length === 0) return stats

  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = getSheetId()

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:I`,
  })
  const rows = res.data.values ?? []

  // index existing rows by order_id
  const byOrder = new Map<string, { r: string[]; rowNum: number }[]>()
  for (let i = 1; i < rows.length; i++) {
    const oid = rows[i][0]
    if (!oid) continue
    if (!byOrder.has(oid)) byOrder.set(oid, [])
    byOrder.get(oid)!.push({ r: rows[i], rowNum: i + 1 })
  }

  const updates: { range: string; values: string[][] }[] = []
  const appendRows: string[][] = []
  const appendedOrderIds = new Set<string>()  // guard against intra-batch dup appends

  for (const { orderId, newStatus, items, shipDate } of orders) {
    const existing = byOrder.get(orderId)

    if (!existing || existing.length === 0) {
      if (items.length === 0 || appendedOrderIds.has(orderId)) { stats.noop++; continue }
      appendedOrderIds.add(orderId)
      appendRows.push(...items.map(itemToRow))
      stats.created++
      continue
    }

    const rowUpdates = existing
      .filter(({ r }) => r[5] !== newStatus)
      .map(({ r, rowNum }) => {
        const u = [...r]
        u[5] = newStatus
        u[6] = (newStatus === 'sent' || newStatus === 'returned') ? shipDate : ''
        while (u.length < 9) u.push('')
        return { range: `${SHEET_NAME}!A${rowNum}:I${rowNum}`, values: [u.slice(0, 9)] }
      })

    if (rowUpdates.length === 0) stats.noop++
    else { updates.push(...rowUpdates); stats.updated++ }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates },
    })
  }
  if (appendRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:I`,
      valueInputOption: 'RAW',
      requestBody: { values: appendRows },
    })
  }

  return stats
}

/**
 * Updates all pending items for a given order_id to the specified status.
 * Called from the amoCRM stage-change webhook.
 */
export async function markOrderStatus(
  orderId: string,
  status: 'sent' | 'returned',
  shipDate: string
): Promise<number> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = getSheetId()

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:I`,
  })
  const rows = res.data.values ?? []
  if (rows.length < 2) return 0

  const updates: { row: number; values: string[] }[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (r[0] === orderId && (r[5] === 'pending' || !r[5])) {
      const updated = [...r]
      updated[5] = status
      updated[6] = shipDate
      while (updated.length < 9) updated.push('')
      updates.push({ row: i + 1, values: updated.slice(0, 9) })
    }
  }

  if (updates.length === 0) return 0

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map(u => ({
        range: `${SHEET_NAME}!A${u.row}:I${u.row}`,
        values: [u.values],
      })),
    },
  })

  return updates.length
}

/**
 * Deletes all sheet rows for a given amoCRM lead ID.
 * Matches column I (lead_id) or column A (AMO-{leadId} fallback).
 * Returns the number of rows deleted.
 */
export async function deleteRowsByLeadId(leadId: string): Promise<number> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const spreadsheetId = getSheetId()

  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const sheetMeta = meta.data.sheets?.find(s => s.properties?.title === SHEET_NAME)
  if (!sheetMeta) return 0
  const sheetId = sheetMeta.properties?.sheetId ?? 0

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:I`,
  })
  const rows = res.data.values ?? []
  const amoOrderId = `AMO-${leadId}`

  // collect 0-based row indices (skip header at index 0)
  const toDelete: number[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if ((r[8] ?? '') === leadId || (r[0] ?? '') === amoOrderId) {
      toDelete.push(i)
    }
  }

  if (toDelete.length === 0) return 0

  // delete bottom-up to keep indices valid during batch
  toDelete.sort((a, b) => b - a)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: toDelete.map(rowIndex => ({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
        },
      })),
    },
  })

  return toDelete.length
}
