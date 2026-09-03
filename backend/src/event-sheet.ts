import { google } from 'googleapis'
import fs from 'node:fs'

/**
 * Лист регистраций на офлайн-мероприятие (шоурум).
 *
 * Пишет сюда только бот — пачкой, раз в 30 секунд, через
 * POST /internal/event-registrations. Поштучная запись 400 гостей упёрлась бы
 * в квоту Sheets (~60 записей в минуту) и остановила бы обработку заказов,
 * которая живёт в той же таблице.
 *
 * Источник истины — event-registrations.json на VDS бота; этот лист витрина
 * для менеджера, поэтому дедуп идёт по chat_id: повторная выгрузка той же
 * строки (потерянный ответ, рестарт) не плодит дублей.
 */

export type EventRegistrationRow = {
  chatId: number
  name: string
  username: string
  visitDate: string     // YYYY-MM-DD
  registeredAt: string  // ISO
}

const SHEET_NAME = process.env.EVENT_SHEET_NAME || 'showroom_2026_09'
const HEADERS = ['name', 'username', 'chat_id', 'visit_date', 'registered_at', 'reminded_at']

// Колонки: A name, B username, C chat_id, D visit_date, E registered_at, F reminded_at.
// reminded_at пока никто не заполняет — колонка-задел под напоминание накануне,
// чтобы потом не пересобирать лист с уже набранными гостями.
const COL_CHAT_ID = 2
const COL_VISIT_DATE = 3

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

// Лист создаём один раз за жизнь процесса: иначе каждая выгрузка тратила бы
// лишние два вызова API (spreadsheets.get + запись заголовка) на пустом месте.
let ensured = false

export async function ensureEventSheet(force = false): Promise<void> {
  if (ensured && !force) return
  const sheets = google.sheets({ version: 'v4', auth: getAuth() })
  const spreadsheetId = getSheetId()

  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const exists = meta.data.sheets?.some(s => s.properties?.title === SHEET_NAME)

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    })
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  })
  ensured = true
}

function toRow(r: EventRegistrationRow): string[] {
  return [
    r.name,
    r.username ? `@${r.username}` : '',
    String(r.chatId),
    r.visitDate,
    r.registeredAt,
    '', // reminded_at
  ]
}

export type UpsertResult = { appended: number; updated: number; skipped: number }

/**
 * Добавляет новых гостей и обновляет дату визита у тех, кто её сменил.
 * Один read + максимум один batchUpdate + максимум один append на вызов.
 */
export async function upsertEventRegistrations(rows: EventRegistrationRow[]): Promise<UpsertResult> {
  const result: UpsertResult = { appended: 0, updated: 0, skipped: 0 }
  if (rows.length === 0) return result

  await ensureEventSheet()

  const sheets = google.sheets({ version: 'v4', auth: getAuth() })
  const spreadsheetId = getSheetId()

  // читаем только то, по чему сверяемся: chat_id и дату визита
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A2:F`,
  })
  const values = existing.data.values ?? []

  // chat_id → номер строки в таблице (1-based, с учётом заголовка)
  const rowByChatId = new Map<string, number>()
  const dateByChatId = new Map<string, string>()
  values.forEach((row, i) => {
    const chatId = String(row[COL_CHAT_ID] ?? '').trim()
    if (!chatId) return
    rowByChatId.set(chatId, i + 2)
    dateByChatId.set(chatId, String(row[COL_VISIT_DATE] ?? '').trim())
  })

  const toAppend: string[][] = []
  const toUpdate: Array<{ range: string; values: string[][] }> = []
  // Страховка от дубля внутри одной пачки: у бота регистрации лежат в Map по
  // chat_id, так что прийти дважды они не могут, но чужой вызов не должен
  // порождать две строки на одного человека.
  const seenInBatch = new Set<string>()

  for (const r of rows) {
    const key = String(r.chatId)
    const existingRow = rowByChatId.get(key)

    if (existingRow === undefined) {
      if (seenInBatch.has(key)) { result.skipped++; continue }
      seenInBatch.add(key)
      toAppend.push(toRow(r))
      result.appended++
      continue
    }

    if (dateByChatId.get(key) === r.visitDate) {
      result.skipped++
      continue
    }
    toUpdate.push({ range: `${SHEET_NAME}!D${existingRow}`, values: [[r.visitDate]] })
    dateByChatId.set(key, r.visitDate)
    result.updated++
  }

  if (toUpdate.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: toUpdate },
    })
  }

  if (toAppend.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:F`,
      valueInputOption: 'RAW',
      requestBody: { values: toAppend },
    })
  }

  return result
}

export function eventSheetName(): string {
  return SHEET_NAME
}
