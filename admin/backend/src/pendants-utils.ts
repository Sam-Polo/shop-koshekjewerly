import { google } from 'googleapis'
import { getAuthFromEnv } from './sheets-utils.js'
import pino from 'pino'

const logger = pino()

export type Pendant = {
  id: string
  title: string
  description?: string
  images: string[]
  price: number
  for_necklace: boolean
  for_earrings: boolean
  for_bracelet: boolean
  /** Артикул компонента (отправляется менеджеру в заказе) */
  article?: string
  /** Текст бейджа на карточке */
  badge_text?: string
  /** Съёмная (true, по умолчанию) или нет. Если в сборку добавлены не‑съёмные подвески — лимит 2 на сборку. */
  removable: boolean
  active: boolean
  order: number
}

const SHEET_NAME = 'pendants'
const HEADERS = [
  'id', 'title', 'description', 'images', 'price',
  'for_necklace', 'for_earrings', 'for_bracelet',
  'article', 'badge_text', 'removable',
  'active', 'order'
]

async function ensurePendantsSheet(sheets: any, sheetId: string): Promise<void> {
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
    logger.info({ sheet: SHEET_NAME }, 'лист pendants создан')
  }
}

function parseBool(v: any): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'да'
}

// removable: пустая ячейка для back-compat = считаем съёмной (true)
function parseRemovable(v: any): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === '') return true
  return s === 'true' || s === '1' || s === 'yes' || s === 'да'
}

export async function fetchPendantsFromSheet(sheetId: string): Promise<Pendant[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  try {
    const range = `${SHEET_NAME}!A1:M1000`
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
    const rows = res.data.values ?? []

    if (rows.length < 2) return []

    const header = rows[0].map((h: string) => h.trim().toLowerCase())
    const idx = (name: string) => header.indexOf(name)

    const items: Pendant[] = []
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length === 0) continue
      const get = (n: string) => String(r[idx(n)] ?? '').trim()
      const id = get('id')
      if (!id) continue

      const order = parseInt(get('order'), 10)
      const price = parseFloat(get('price'))

      const imagesRaw = get('images') || get('image')
      const images = imagesRaw
        ? imagesRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
        : []

      items.push({
        id,
        title: get('title') || id,
        description: get('description') || undefined,
        images,
        price: Number.isFinite(price) ? price : 0,
        for_necklace: parseBool(get('for_necklace')),
        for_earrings: parseBool(get('for_earrings')),
        for_bracelet: parseBool(get('for_bracelet')),
        article: get('article') || undefined,
        badge_text: get('badge_text') || undefined,
        removable: parseRemovable(get('removable')),
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

export async function savePendantsToSheet(sheetId: string, items: Pendant[]): Promise<void> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  await ensurePendantsSheet(sheets, sheetId)

  const values = [
    HEADERS,
    ...items.map((it, i) => [
      it.id,
      it.title,
      it.description || '',
      it.images.join('\n'),
      it.price,
      it.for_necklace ? 'true' : 'false',
      it.for_earrings ? 'true' : 'false',
      it.for_bracelet ? 'true' : 'false',
      it.article || '',
      it.badge_text || '',
      it.removable ? 'true' : 'false',
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
      logger.debug({ error: e?.message }, 'очистка лишних строк pendants')
    }
  }

  logger.info({ count: items.length }, 'подвески сохранены в Google Sheets')
}
