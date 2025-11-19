import { google } from 'googleapis'
import fs from 'node:fs'

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
}

function getAuthFromEnv() {
  // можно указать GOOGLE_SA_FILE=путь/к/sa.json или GOOGLE_SA_JSON=строкой
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
    const stock = Number(get('stock'))
    const article = String(get('article') || '').trim() || undefined
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
    }
    // простая валидация
    if (!item.title || !item.slug) continue
    out.push(item)
  }
  return out
}

// читаем все листы с товарами (по категориям)
export async function fetchProductsFromSheet(sheetId: string): Promise<SheetProduct[]> {
  const auth = getAuthFromEnv()
  
  // названия листов по категориям (можно настроить через env)
  const sheetNames = process.env.SHEET_NAMES?.split(',') || [
    'ягоды',
    'выпечка',
    'pets',
    'шея',
    'руки',
    'уши',
    'сертификаты'
  ]
  
  const allProducts: SheetProduct[] = []
  
  for (const sheetName of sheetNames) {
    try {
      // читаем диапазон A1:J1000 из каждого листа (добавлена колонка article в конце)
      const range = `${sheetName.trim()}!A1:J1000`
      const products = await fetchSheetRange(auth, sheetId, range, sheetName.trim())
      allProducts.push(...products)
    } catch (e: any) {
      // если лист не найден, пропускаем
      console.warn(`Не удалось прочитать лист "${sheetName}": ${e.message}`)
    }
  }
  
  return allProducts
}


