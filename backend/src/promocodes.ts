import { google } from 'googleapis'
import fs from 'node:fs'

export type Promocode = {
  code: string // код промокода (уникальный)
  type: 'amount' | 'percent' // тип: сумма или процент
  value: number // значение (сумма в рублях или процент)
  expiresAt?: string // дата окончания в формате ISO (YYYY-MM-DDTHH:mm:ss)
  active: boolean // активен ли промокод
  createdAt?: string // дата создания
  productSlugs?: string[] // массив slug'ов товаров, для которых действует промокод (если пусто или null - действует на все товары)
  source?: string // источник промокода: 'certificate' для сертификатных
}

function getCredsFromEnv() {
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  if (filePath) return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (raw) return JSON.parse(raw)
  throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE is required')
}

function getAuthFromEnv() {
  const creds = getCredsFromEnv()
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, ['https://www.googleapis.com/auth/spreadsheets.readonly'])
}

function getWriteAuth() {
  const creds = getCredsFromEnv()
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, ['https://www.googleapis.com/auth/spreadsheets'])
}

// чтение всех промокодов из Google Sheets
export async function fetchPromocodesFromSheet(sheetId: string): Promise<Promocode[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })
  
  try {
    const range = 'promocodes!A1:H1000'
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
    const rows = res.data.values ?? []
    
    if (rows.length === 0) return []
    
    const header = rows[0].map((h: string) => h.trim().toLowerCase())
    const idx = (name: string) => header.indexOf(name)
    const out: Promocode[] = []
    
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length === 0) continue
      
      const get = (n: string) => r[idx(n)] ?? ''
      const code = String(get('code') || '').trim().toUpperCase()
      const type = String(get('type') || '').trim().toLowerCase()
      const valueRaw = String(get('value') || '').trim()
      const expiresAtRaw = String(get('expires_at') || get('expiresat') || '').trim()
      const activeVal = String(get('active') || '').toLowerCase()
      const productSlugsRaw = String(get('product_slugs') || get('productslugs') || '').trim()
      const sourceRaw = String(get('source') || '').trim()
      
      if (!code) continue // пропускаем строки без кода
      
      const value = Number(valueRaw.replace(',', '.'))
      if (!Number.isFinite(value) || value <= 0) continue
      
      if (type !== 'amount' && type !== 'percent') continue
      
      if (type === 'percent' && value > 100) continue // процент не может быть больше 100
      
      const active = activeVal === 'true' || activeVal === '1' || activeVal === 'yes'
      
      // парсим дату окончания (формат: YYYY-MM-DDTHH:mm:ss или YYYY-MM-DD)
      let expiresAt: string | undefined = undefined
      if (expiresAtRaw) {
        try {
          // пробуем разные форматы
          const date = new Date(expiresAtRaw)
          if (!isNaN(date.getTime())) {
            expiresAt = date.toISOString()
          }
        } catch (e) {
          // игнорируем ошибки парсинга даты
        }
      }
      
      // парсим productSlugs (разделенные запятыми или пробелами)
      let productSlugs: string[] | undefined = undefined
      if (productSlugsRaw) {
        productSlugs = productSlugsRaw
          .split(/[,\s]+/)
          .map(s => s.trim())
          .filter(s => s.length > 0)
        if (productSlugs.length === 0) {
          productSlugs = undefined
        }
      }
      
      out.push({
        code,
        type: type as 'amount' | 'percent',
        value,
        expiresAt,
        active,
        productSlugs,
        ...(sourceRaw ? { source: sourceRaw } : {})
      })
    }
    
    return out
  } catch (e: any) {
    console.warn(`Не удалось прочитать лист "promocodes": ${e.message}`)
    return []
  }
}

// хранение промокодов в памяти
const state = {
  promocodes: [] as Promocode[],
}

// загрузка промокодов в память
export function loadPromocodes(promocodes: Promocode[]) {
  state.promocodes = promocodes
}

// получение всех промокодов
export function listPromocodes(): Promocode[] {
  return state.promocodes
}

// поиск промокода по коду
export function findPromocode(code: string): Promocode | undefined {
  const normalizedCode = code.trim().toUpperCase()
  return state.promocodes.find(p => p.code === normalizedCode)
}

// ── Certificate promo code generation ────────────────────────────────────────

const CERT_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // без 0/O/I/1

function generateCertCode(): string {
  let code: string
  do {
    code = 'CERT-' + Array.from({ length: 8 }, () =>
      CERT_CHARS[Math.floor(Math.random() * CERT_CHARS.length)]
    ).join('')
  } while (state.promocodes.some(p => p.code === code))
  return code
}

// Создаёт промокод сертификата: пишет в Google Sheets и добавляет в память.
// Возвращает сгенерированный код.
export async function saveCertificatePromocode(sheetId: string, certValue: number): Promise<string> {
  const code = generateCertCode()

  const auth = getWriteAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  // читаем заголовки, чтобы выставить значения по позиции
  const headersRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'promocodes!A1:H1',
  })
  const headers = (headersRes.data.values?.[0] ?? []).map((h: string) => h.trim().toLowerCase())
  const numCols = Math.max(headers.length, 7)
  const row: string[] = new Array(numCols).fill('')

  const set = (name: string, val: string) => {
    const i = headers.indexOf(name)
    if (i >= 0) row[i] = val
  }

  set('code', code)
  set('type', 'amount')
  set('value', String(certValue))
  set('expires_at', '')
  set('active', '1')
  set('product_slugs', '')
  set('source', 'certificate')

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'promocodes!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  })

  // добавляем в память сразу, чтобы код был валиден без следующего импорта
  state.promocodes.push({
    code,
    type: 'amount',
    value: certValue,
    active: true,
    source: 'certificate',
  })

  return code
}

// Деактивирует промокод сертификата (одноразовый): в памяти и в Google Sheets.
export async function deactivateCertificatePromocode(sheetId: string, code: string): Promise<void> {
  const normalizedCode = code.trim().toUpperCase()

  // сразу обновляем память
  const promo = state.promocodes.find(p => p.code === normalizedCode)
  if (promo) promo.active = false

  // находим и обновляем строку в листе
  const auth = getWriteAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'promocodes!A1:H1000',
  })
  const rows = res.data.values ?? []
  if (rows.length === 0) return

  const headers = rows[0].map((h: string) => h.trim().toLowerCase())
  const codeIdx = headers.indexOf('code')
  const activeIdx = headers.indexOf('active')
  if (codeIdx < 0 || activeIdx < 0) return

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i]?.[codeIdx] ?? '').trim().toUpperCase() === normalizedCode) {
      const rowNum = i + 1 // 1-indexed
      const activeCol = String.fromCharCode(65 + activeIdx)
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `promocodes!${activeCol}${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['0']] },
      })
      break
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// проверка промокода (возвращает скидку или null)
// orderItemSlugs - массив slug'ов товаров в заказе
export function validatePromocode(
  promocode: Promocode, 
  orderTotal: number,
  orderItemSlugs: string[] = []
): number | null {
  // проверяем активность
  if (!promocode.active) {
    return null
  }
  
  // проверяем срок действия
  if (promocode.expiresAt) {
    const now = new Date()
    const expiresAt = new Date(promocode.expiresAt)
    if (now > expiresAt) {
      return null
    }
  }
  
  // проверяем соответствие товаров (если промокод привязан к конкретным товарам)
  if (promocode.productSlugs && promocode.productSlugs.length > 0) {
    // промокод действует только на указанные товары
    // проверяем, что хотя бы один товар из заказа есть в списке товаров промокода
    const hasMatchingProduct = orderItemSlugs.some(slug => promocode.productSlugs!.includes(slug))
    if (!hasMatchingProduct) {
      return null // нет подходящих товаров
    }
  }
  // если productSlugs пусто или null - промокод действует на все товары
  
  // вычисляем скидку
  if (promocode.type === 'amount') {
    // скидка по сумме (не может быть больше суммы заказа)
    return Math.min(promocode.value, orderTotal)
  } else {
    // скидка по проценту
    const discount = (orderTotal * promocode.value) / 100
    return Math.round(discount * 100) / 100 // округляем до 2 знаков
  }
}

