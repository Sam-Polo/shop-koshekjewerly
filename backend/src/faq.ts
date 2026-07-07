import { google } from 'googleapis'
import fs from 'node:fs'

// ── FAQ («Ответы на ваши вопросы» в модалке «О нас» мини-аппа) ─────────────────
// Хранится в листе `faq` той же таблицы (колонки: question | answer).
// Порядок строк = порядок отображения. Редактируется из админки.
// Если листа нет или он пуст — фронт показывает захардкоженный фоллбэк.

export type FaqItem = {
  question: string
  answer: string
}

function getAuthFromEnv() {
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
  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly']
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, scopes)
}

// TTL-кэш (как у настроек заказов — 5 минут по умолчанию)
let _cachedFaq: FaqItem[] | null = null
let _faqCachedAt = 0

function faqTtlMs(): number {
  return Number(process.env.SETTINGS_CACHE_TTL_SECONDS ?? 300) * 1000
}

export function invalidateFaqCache(): void {
  _cachedFaq = null
  _faqCachedAt = 0
}

export async function getCachedFaq(sheetId: string): Promise<FaqItem[]> {
  const now = Date.now()
  if (_cachedFaq !== null && now - _faqCachedAt < faqTtlMs()) {
    return _cachedFaq
  }
  const items = await fetchFaqFromSheet(sheetId)
  _cachedFaq = items
  _faqCachedAt = now
  return items
}

export async function fetchFaqFromSheet(sheetId: string): Promise<FaqItem[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })
  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
    const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === 'faq')
    if (!sheetExists) return []

    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'faq!A1:B100' })
    const rows = res.data.values ?? []
    const items: FaqItem[] = []
    // первая строка — заголовки (question | answer)
    for (let i = 1; i < rows.length; i++) {
      const question = String(rows[i]?.[0] ?? '').trim()
      const answer = String(rows[i]?.[1] ?? '').trim()
      if (!question || !answer) continue
      items.push({ question, answer })
    }
    return items
  } catch (e: any) {
    console.error('ошибка чтения FAQ из Sheets:', e?.message)
    return []
  }
}
