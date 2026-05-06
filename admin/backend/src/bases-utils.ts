import { google } from 'googleapis'
import { getAuthFromEnv } from './sheets-utils.js'
import pino from 'pino'

const logger = pino()

export type JewelryType = 'necklace' | 'earrings' | 'bracelet'

export type Base = {
  id: string
  title: string
  description?: string
  image: string
  price: number
  for_necklace: boolean
  for_earrings: boolean
  for_bracelet: boolean
  /**
   * Лимит подвесок для типа. Применяется только если for_<type>=true.
   * 0 — без ограничения. Пусто (null/undefined) — по умолчанию = 1.
   */
  limit_necklace?: number | null
  limit_earrings?: number | null
  limit_bracelet?: number | null
  active: boolean
  order: number
}

const SHEET_NAME = 'bases'
const HEADERS = [
  'id', 'title', 'description', 'image', 'price',
  'for_necklace', 'for_earrings', 'for_bracelet',
  'limit_necklace', 'limit_earrings', 'limit_bracelet',
  'active', 'order'
]

async function ensureBasesSheet(sheets: any, sheetId: string): Promise<void> {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
  const exists = spreadsheet.data.sheets?.some((s: any) => s.properties?.title === SHEET_NAME)
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }]
      }
    })
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_NAME}!A1:M1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADERS] }
    })
    logger.info({ sheet: SHEET_NAME }, 'лист bases создан')
  }
}

function parseBool(v: any): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'да'
}

function parseLimit(v: any): number | null {
  const s = String(v ?? '').trim()
  if (s === '') return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export async function fetchBasesFromSheet(sheetId: string): Promise<Base[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  try {
    const range = `${SHEET_NAME}!A1:M1000`
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
    const rows = res.data.values ?? []

    if (rows.length < 2) return []

    const header = rows[0].map((h: string) => h.trim().toLowerCase())
    const idx = (name: string) => header.indexOf(name)

    const items: Base[] = []
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length === 0) continue
      const get = (n: string) => String(r[idx(n)] ?? '').trim()
      const id = get('id')
      if (!id) continue

      const order = parseInt(get('order'), 10)
      const price = parseFloat(get('price'))

      items.push({
        id,
        title: get('title') || id,
        description: get('description') || undefined,
        image: get('image') || '',
        price: Number.isFinite(price) ? price : 0,
        for_necklace: parseBool(get('for_necklace')),
        for_earrings: parseBool(get('for_earrings')),
        for_bracelet: parseBool(get('for_bracelet')),
        limit_necklace: parseLimit(get('limit_necklace')),
        limit_earrings: parseLimit(get('limit_earrings')),
        limit_bracelet: parseLimit(get('limit_bracelet')),
        active: parseBool(get('active')),
        order: Number.isFinite(order) ? order : i
      })
    }

    items.sort((a, b) => a.order - b.order)
    return items
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (msg.includes('Unable to parse range') || e?.code === 400) return []
    throw e
  }
}

export async function saveBasesToSheet(sheetId: string, items: Base[]): Promise<void> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  await ensureBasesSheet(sheets, sheetId)

  const values = [
    HEADERS,
    ...items.map((it, i) => [
      it.id,
      it.title,
      it.description || '',
      it.image,
      it.price,
      it.for_necklace ? 'true' : 'false',
      it.for_earrings ? 'true' : 'false',
      it.for_bracelet ? 'true' : 'false',
      it.limit_necklace == null ? '' : it.limit_necklace,
      it.limit_earrings == null ? '' : it.limit_earrings,
      it.limit_bracelet == null ? '' : it.limit_bracelet,
      it.active ? 'true' : 'false',
      i
    ])
  ]

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A1:M${values.length}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  })

  if (values.length < 1000) {
    try {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: sheetId,
        range: `${SHEET_NAME}!A${values.length + 1}:M1000`
      })
    } catch (e: any) {
      logger.debug({ error: e?.message }, 'очистка лишних строк bases')
    }
  }

  logger.info({ count: items.length }, 'основы сохранены в Google Sheets')
}
