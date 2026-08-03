import { google } from 'googleapis'
import fs from 'node:fs'

/**
 * Опция товара — одна группа выбора (размер / длина цепочки / цвет…).
 * Название группы задаёт менеджер, поэтому опция универсальна, а не «размер».
 * На цену и остаток не влияет: это информация для менеджера, что отгружать.
 */
export type ProductOption = {
  name: string
  values: string[]
}

export type SheetProduct = {
  id?: string
  slug: string
  title: string
  description?: string
  category: string
  price_rub: number
  discount_price_rub?: number // цена со скидкой (если заполнена - используется вместо price_rub)
  badge_text?: string // текст плашки (например, "СКИДКА", "НОВИНКА", "ПЕРСОНАЛИЗАЦИЯ")
  images: string[]
  active: boolean
  stock?: number
  article?: string // артикул товара (4-значный, уникальный)
  coming_drop?: boolean
  options?: ProductOption // выбор покупателя в карточке (обязателен, если задан)
}

// ограничители, чтобы мусор в ячейке не ломал карточку товара
const OPTION_NAME_MAX = 40
const OPTION_VALUE_MAX = 40
const OPTION_VALUES_MAX = 24

/**
 * Разбирает ячейку `options` формата `Название: вариант1, вариант2, вариант3`.
 * Без двоеточия вся строка считается списком вариантов с именем по умолчанию —
 * менеджер, вписавший «16, 17, 18», получит рабочий выбор, а не пустоту.
 * Пустая/мусорная ячейка → undefined (товар без опций, как было до фичи).
 */
export function parseProductOptions(raw: string): ProductOption | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined

  const sep = text.indexOf(':')
  const name = sep >= 0 ? text.slice(0, sep).trim() : 'Опция'
  const valuesRaw = sep >= 0 ? text.slice(sep + 1) : text

  const seen = new Set<string>()
  const values: string[] = []
  for (const part of valuesRaw.split(',')) {
    const v = part.trim().slice(0, OPTION_VALUE_MAX)
    if (!v || seen.has(v)) continue
    seen.add(v)
    values.push(v)
    if (values.length >= OPTION_VALUES_MAX) break
  }

  if (!name || values.length === 0) return undefined
  return { name: name.slice(0, OPTION_NAME_MAX), values }
}

function getCredsFromEnv(): any {
  // можно указать GOOGLE_SA_FILE=путь/к/sa.json или GOOGLE_SA_JSON=строкой
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  if (filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } else if (raw) {
    return JSON.parse(raw)
  } else {
    throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE is required')
  }
}

function getAuthFromEnv() {
  const creds = getCredsFromEnv()
  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly']
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, scopes)
}

function getWriteAuthFromEnv() {
  const creds = getCredsFromEnv()
  const scopes = ['https://www.googleapis.com/auth/spreadsheets']
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, scopes)
}

/** Имя колонки Google Sheets по индексу (0 → A, 26 → AA). */
function colLetter(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

// читаем один лист и проставляем категорию автоматически
async function fetchSheetRange(auth: any, sheetId: string, range: string, categoryName: string): Promise<SheetProduct[]> {
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
  const rows = res.data.values ?? []
  if (rows.length === 0) return []
  const header = rows[0].map((h: string) => h.trim().toLowerCase())
  const idx = (name: string) => header.indexOf(name)
  const out: SheetProduct[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.length === 0) continue // пропускаем пустые строки
    const get = (n: string) => r[idx(n)] ?? ''
    const price = Number(String(get('price_rub')).replace(',', '.'))
    const discountPriceRaw = String(get('discount_price_rub') || '').trim()
    const discountPrice = discountPriceRaw ? Number(discountPriceRaw.replace(',', '.')) : undefined
    const badgeText = String(get('badge_text') || '').trim() || undefined
    // парсим изображения: разделители могут быть запятая или перенос строки
    const imagesRaw = String(get('images'))
    const images: string[] = imagesRaw
      .split(/[,\n]/) // разбиваем по запятой или переносу строки
      .map(s => s.trim())
      .filter(Boolean)
    const activeVal = String(get('active')).toLowerCase()
    const active = activeVal === 'true' || activeVal === '1' || activeVal === 'yes'
    // пустая ячейка не должна давать stock=0 (Number('') === 0) — иначе «товар закончился»
    const stockIdx = idx('stock')
    const stockRaw = stockIdx !== -1 ? String(get('stock')).trim() : ''
    const stockParsed = stockRaw === '' ? NaN : Number(stockRaw.replace(',', '.'))
    const stock = Number.isFinite(stockParsed) ? stockParsed : undefined
    const article = String(get('article') || '').trim() || undefined
    const comingDropRaw = String(get('coming_drop') || '').trim().toLowerCase()
    const coming_drop = comingDropRaw === 'true' || comingDropRaw === '1' || comingDropRaw === 'yes' ? true : undefined
    const options = idx('options') !== -1 ? parseProductOptions(String(get('options'))) : undefined
    const item: SheetProduct = {
      id: String(get('id') || '').trim() || undefined,
      slug: String(get('slug')).trim(),
      title: String(get('title')).trim(),
      description: String(get('description') || '').trim() || undefined,
      category: categoryName, // категория берётся из имени листа
      price_rub: Number.isFinite(price) ? price : 0,
      discount_price_rub: discountPrice && Number.isFinite(discountPrice) ? discountPrice : undefined,
      badge_text: badgeText,
      images,
      active,
      stock: Number.isFinite(stock) ? stock : undefined,
      article: article || undefined,
      coming_drop,
      options,
    }
    // простая валидация
    if (!item.title || !item.slug) continue
    out.push(item)
  }
  return out
}

// получаем список имён листов: из categories или из env SHEET_NAMES
async function getSheetNames(sheetId: string): Promise<string[]> {
  try {
    const { fetchCategoriesFromSheet } = await import('./categories.js')
    const categories = await fetchCategoriesFromSheet(sheetId)
    if (categories.length > 0) {
      return categories.map((c) => c.key)
    }
  } catch (_) {
    // игнорируем
  }
  return process.env.SHEET_NAMES?.split(',').map((s) => s.trim()) || [
    'ягоды',
    'выпечка',
    'pets',
    'шея',
    'руки',
    'уши',
    'сертификаты'
  ]
}

// читаем все листы с товарами (по категориям)
export async function fetchProductsFromSheet(sheetId: string): Promise<SheetProduct[]> {
  const auth = getAuthFromEnv()
  const sheetNames = await getSheetNames(sheetId)
  const allProducts: SheetProduct[] = []

  for (const sheetName of sheetNames) {
    try {
      // читаем диапазон A1:L1000 из каждого листа (последняя колонка — options).
      // Новая колонка обязана попадать в диапазон, иначе бэкенд её просто не увидит.
      const range = `${sheetName.trim()}!A1:L1000`
      const products = await fetchSheetRange(auth, sheetId, range, sheetName.trim())
      allProducts.push(...products)
    } catch (e: any) {
      // если лист не найден, пропускаем
      console.warn(`Не удалось прочитать лист "${sheetName}": ${e.message}`)
    }
  }
  
  return allProducts
}

/**
 * Списывает остаток товара read-modify-write прямо по листу категории (источник истины) —
 * переживает засыпание Render и не теряется при следующем импорте каталога, в отличие от
 * прежней схемы с буфером в памяти. Читает свежее значение ячейки перед записью, поэтому
 * не затирает ручную правку остатка менеджером, если она произошла раньше этого вызова.
 * Возвращает новый остаток, либо null если строка/лист не найдены или остаток безлимитный
 * (пустая ячейка — писать нечего).
 */
export async function decreaseStockInSheet(
  sheetId: string,
  category: string,
  slug: string,
  quantity: number
): Promise<number | null> {
  const auth = getWriteAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  const range = `${category}!A1:L1000`
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
  const rows = res.data.values ?? []
  if (rows.length === 0) return null

  const headers = rows[0].map((h: string) => String(h).trim().toLowerCase())
  const slugIdx = headers.indexOf('slug')
  const stockIdx = headers.indexOf('stock')
  if (slugIdx < 0 || stockIdx < 0) return null

  const rowNum = rows.findIndex((r, i) => i > 0 && String(r?.[slugIdx] ?? '').trim() === slug)
  if (rowNum < 1) return null

  const raw = String(rows[rowNum]?.[stockIdx] ?? '').trim()
  if (raw === '') return null // пустая ячейка = безлимит, decrementить нечего

  const current = Number(raw.replace(',', '.'))
  if (!Number.isFinite(current)) return null

  const next = Math.max(0, current - quantity)

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${category}!${colLetter(stockIdx)}${rowNum + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[String(next)]] },
  })

  return next
}


