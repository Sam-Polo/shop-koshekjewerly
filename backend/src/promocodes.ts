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
}

function getAuthFromEnv() {
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  let creds: any
  
  if (filePath) {
    const txt = fs.readFileSync(filePath, 'utf8')
    creds = JSON.parse(txt)
  } else if (raw) {
    creds = JSON.parse(raw)
  } else {
    throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE is required')
  }
  
  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly']
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, scopes)
}

// чтение всех промокодов из Google Sheets
export async function fetchPromocodesFromSheet(sheetId: string): Promise<Promocode[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })
  
  try {
    const range = 'promocodes!A1:G1000'
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
        productSlugs
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

