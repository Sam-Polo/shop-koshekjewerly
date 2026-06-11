/**
 * One-off script: import historical paid orders from Google Sheets into amoCRM.
 * Orders from May 31, 2026 onwards. Stage is determined by track status:
 *   - cdek_track_number filled OR admin_note starts with "track:" → ОТПРАВЛЕН (142)
 *   - otherwise → НОВЫЙ, ЖДЕТ ОТПРАВКИ (86423886)
 *
 * Run: npx tsx src/scripts/import-historical-orders.ts
 */

import 'dotenv/config'
import { google } from 'googleapis'
import fs from 'node:fs'

// ── amoCRM config ─────────────────────────────────────────────────────────────

const AMO_BASE = `https://${process.env.AMOCRM_SUBDOMAIN}.amocrm.ru`
const AMO_TOKEN = process.env.AMOCRM_ACCESS_TOKEN!
const PIPELINE_ID = Number(process.env.AMOCRM_PIPELINE_ID)
const STAGE_NEW = Number(process.env.AMOCRM_STAGE_TO_SEND_ID)   // НОВЫЙ, ЖДЕТ ОТПРАВКИ
const STAGE_SENT = 142                                            // ОТПРАВЛЕН

// field IDs
const F = {
  source:      Number(process.env.AMOCRM_FIELD_SOURCE_ID),
  sourceEnum:  (platform: string) => platform === 'max'
    ? Number(process.env.AMOCRM_ENUM_SOURCE_MAX)
    : Number(process.env.AMOCRM_ENUM_SOURCE_TELEGRAM),
  orderNum:    Number(process.env.AMOCRM_FIELD_ORDER_NUMBER_ID),
  date:        Number(process.env.AMOCRM_FIELD_DATE_ID),
  items:       Number(process.env.AMOCRM_FIELD_ITEMS_ID),
  address:     Number(process.env.AMOCRM_FIELD_ADDRESS_ID),
  comment:     Number(process.env.AMOCRM_FIELD_COMMENT_ID),
  cdekTrack:   Number(process.env.AMOCRM_FIELD_CDEK_TRACK_ID),
  trackLink:   Number(process.env.AMOCRM_FIELD_TRACK_LINK_ID),
  tgId:        Number(process.env.AMOCRM_CONTACT_FIELD_TG_ID),
  tgUsername:  Number(process.env.AMOCRM_CONTACT_FIELD_TG_USERNAME),
}

const FROM_DATE = new Date('2026-05-31T00:00:00.000Z').getTime()
const DELAY_MS = 300 // пауза между запросами чтобы не превысить rate limit amoCRM

// ── Sheets auth ───────────────────────────────────────────────────────────────

function getSheetsApi() {
  const raw = process.env.GOOGLE_SA_JSON
  const filePath = process.env.GOOGLE_SA_FILE
  let creds: any
  if (filePath) creds = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  else if (raw) creds = JSON.parse(raw)
  else throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE required')
  const auth = new google.auth.JWT(
    creds.client_email, undefined, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  )
  return google.sheets({ version: 'v4', auth })
}

// ── amoCRM fetch ──────────────────────────────────────────────────────────────

async function amoPost(path: string, body: unknown): Promise<any> {
  const resp = await fetch(`${AMO_BASE}/api/v4${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AMO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`amoCRM POST ${path} → ${resp.status}: ${text.slice(0, 300)}`)
  }
  return resp.json()
}

async function amoGet(path: string): Promise<any> {
  const resp = await fetch(`${AMO_BASE}/api/v4${path}`, {
    headers: { Authorization: `Bearer ${AMO_TOKEN}` },
  })
  if (resp.status === 204) return null
  if (!resp.ok) return null
  return resp.json()
}

async function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

// ── Find or create contact ────────────────────────────────────────────────────

async function findOrCreateContact(fullName: string, phone: string, chatId: string, username: string, platform: string): Promise<number> {
  const search = await amoGet(`/contacts?query=${encodeURIComponent(phone)}&limit=1`)
  const existing = search?._embedded?.contacts?.[0]
  if (existing?.id) return existing.id as number

  const customFields: any[] = [
    { field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] },
  ]
  if (chatId && F.tgId && platform !== 'max') customFields.push({ field_id: F.tgId, values: [{ value: Number(chatId) }] })
  if (username && F.tgUsername) customFields.push({ field_id: F.tgUsername, values: [{ value: `@${username}` }] })

  const result = await amoPost('/contacts', [{ name: fullName, custom_fields_values: customFields }])
  const contact = result?._embedded?.contacts?.[0]
  if (!contact?.id) throw new Error(`не удалось создать контакт для ${fullName}`)
  return contact.id as number
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const spreadsheetId = process.env.IMPORT_SHEET_ID
  if (!spreadsheetId) throw new Error('IMPORT_SHEET_ID not set')

  const api = getSheetsApi()

  console.log('Читаем Google Sheets...')
  const [ordersRes, itemsRes] = await Promise.all([
    api.spreadsheets.values.get({ spreadsheetId, range: 'orders!A:Y' }),
    api.spreadsheets.values.get({ spreadsheetId, range: 'order_items!A:G' }),
  ])

  const orderRows = (ordersRes.data.values || []).slice(1) as string[][]
  const itemRows = (itemsRes.data.values || []).slice(1) as string[][]

  // индекс товаров по order_id
  const itemsByOrder = new Map<string, Array<{ title: string; price: number; quantity: number }>>()
  for (const row of itemRows) {
    const oid = row[0]
    if (!oid) continue
    const bucket = itemsByOrder.get(oid) ?? []
    bucket.push({ title: row[2] ?? '', price: parseFloat(row[3]) || 0, quantity: parseInt(row[4], 10) || 1 })
    itemsByOrder.set(oid, bucket)
  }

  // фильтруем нужные заказы
  const toImport = orderRows.filter(row => {
    if (!row[0]) return false
    if (row[3] !== 'paid') return false
    const ts = row[1] ? new Date(row[1]).getTime() : 0
    return ts >= FROM_DATE
  })

  console.log(`Найдено ${toImport.length} оплаченных заказов с 31 мая.`)

  let created = 0, skipped = 0, errors = 0

  for (const row of toImport) {
    const orderId     = row[0]
    const createdAt   = row[1] ? new Date(row[1]).getTime() : Date.now()
    const platform    = row[4] || 'telegram'
    const chatId      = row[5] || ''
    const customerName = row[6] || ''
    const fullName    = row[7] || customerName || 'Без имени'
    const phone       = row[8] || ''
    const username    = row[9] || ''
    const city        = row[11] || ''
    const address     = row[12] || city
    const total       = parseFloat(row[20]) || 0
    const comment     = row[21] || ''
    const adminNote   = row[22] || ''
    const cdekTrack   = row[24] || ''

    const isShipped = !!cdekTrack || adminNote.startsWith('track:')
    const stageId = isShipped ? STAGE_SENT : STAGE_NEW

    const items = itemsByOrder.get(orderId) ?? []
    const itemsText = items.length
      ? items.map(i => `${i.title}${i.quantity > 1 ? ` × ${i.quantity}` : ''} — ${i.price * i.quantity}₽`).join('\n')
      : ''

    const customFields: any[] = []
    const push = (fieldId: number, value: unknown) => {
      if (fieldId && value !== undefined && value !== null && value !== '') {
        customFields.push({ field_id: fieldId, values: [{ value }] })
      }
    }
    const pushEnum = (fieldId: number, enumId: number) => {
      if (fieldId && enumId) customFields.push({ field_id: fieldId, values: [{ enum_id: enumId }] })
    }

    pushEnum(F.source, F.sourceEnum(platform))
    push(F.orderNum, orderId)
    push(F.date, Math.floor(createdAt / 1000))
    push(F.items, itemsText)
    push(F.address, address)
    if (comment) push(F.comment, comment)
    if (cdekTrack) {
      push(F.cdekTrack, cdekTrack)
      push(F.trackLink, `https://www.cdek.ru/track?order_id=${cdekTrack}`)
    } else if (adminNote.startsWith('track:')) {
      const url = adminNote.replace(/^track:\s*/, '').split('\n')[0].trim()
      push(F.trackLink, url)
    }

    try {
      if (!phone) {
        console.warn(`  [SKIP] ${orderId} — нет телефона`)
        skipped++
        continue
      }

      await sleep(DELAY_MS)
      const contactId = await findOrCreateContact(fullName, phone, chatId, username, platform)

      await sleep(DELAY_MS)
      const result = await amoPost('/leads', [{
        name: `${fullName} — ${total}₽`,
        price: total,
        pipeline_id: PIPELINE_ID,
        status_id: stageId,
        custom_fields_values: customFields,
        _embedded: { contacts: [{ id: contactId, is_main: true }] },
      }])
      const lead = result?._embedded?.leads?.[0]
      const stage = isShipped ? 'ОТПРАВЛЕН' : 'НОВЫЙ'
      console.log(`  [OK] ${orderId} → лид ${lead?.id} [${stage}]${isShipped && cdekTrack ? ` трек: ${cdekTrack}` : ''}`)
      created++
    } catch (e: any) {
      console.error(`  [ERR] ${orderId}: ${e?.message}`)
      errors++
    }
  }

  console.log(`\nГотово. Создано: ${created}, пропущено: ${skipped}, ошибок: ${errors}`)
}

main().catch(e => { console.error(e); process.exit(1) })
