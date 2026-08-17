import { google } from 'googleapis'
import fs from 'node:fs'

// ── Правила использования и гарантийные условия ───────────────────────────────
// Показываются отдельным ОБЯЗАТЕЛЬНЫМ экраном между оформлением заказа и
// переходом к оплате: покупатель подтверждает галочкой, что ознакомился.
//
// Хранится в листе `rules` той же таблицы, ЦЕЛИКОМ в одной ячейке A2.
// Одна ячейка, а не строка-на-абзац: пустые строки — часть разметки (они делят
// текст на абзацы), а Sheets схлопывает пустые строки при чтении диапазона и
// разметка бы поехала. Редактируется из админки одним полем.
//
// Разметка (её же понимает мини-апп):
//   `## `  — заголовок раздела
//   `### ` — подзаголовок
//   `• `   — пункт списка
//   пустая строка — граница абзаца
//
// Пустой ответ = мини-апп покажет захардкоженный текст по умолчанию. Экран
// обязательный, пропустить его при недоступных Sheets нельзя.

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

// TTL-кэш (как у FAQ и настроек заказов — 5 минут по умолчанию)
let _cachedRules: string | null = null
let _rulesCachedAt = 0

function rulesTtlMs(): number {
  return Number(process.env.SETTINGS_CACHE_TTL_SECONDS ?? 300) * 1000
}

export function invalidateRulesCache(): void {
  _cachedRules = null
  _rulesCachedAt = 0
}

export async function getCachedRules(sheetId: string): Promise<string> {
  const now = Date.now()
  if (_cachedRules !== null && now - _rulesCachedAt < rulesTtlMs()) {
    return _cachedRules
  }
  const text = await fetchRulesFromSheet(sheetId)
  _cachedRules = text
  _rulesCachedAt = now
  return text
}

export async function fetchRulesFromSheet(sheetId: string): Promise<string> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })
  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
    const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === 'rules')
    if (!sheetExists) return ''

    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'rules!A2' })
    const text = String(res.data.values?.[0]?.[0] ?? '').trim()
    return text
  } catch (e: any) {
    console.error('ошибка чтения правил из Sheets:', e?.message)
    return ''
  }
}
