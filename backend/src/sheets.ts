import { google } from 'googleapis'
import fs from 'node:fs'

export type SheetProduct = {
  id?: string
  slug: string
  title: string
  description?: string
  category: string
  price_rub: number
  images: string[]
  active: boolean
  stock?: number
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

export async function fetchProductsFromSheet(sheetId: string, range = 'A1:I1000'): Promise<SheetProduct[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
  const rows = res.data.values ?? []
  if (rows.length === 0) return []
  const header = rows[0].map((h: string) => h.trim().toLowerCase())
  const idx = (name: string) => header.indexOf(name)
  const out: SheetProduct[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const get = (n: string) => r[idx(n)] ?? ''
    const price = Number(String(get('price_rub')).replace(',', '.'))
    const images: string[] = String(get('images'))
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const activeVal = String(get('active')).toLowerCase()
    const active = activeVal === 'true' || activeVal === '1' || activeVal === 'yes'
    const stock = Number(get('stock'))
    const item: SheetProduct = {
      id: String(get('id') || '').trim() || undefined,
      slug: String(get('slug')).trim(),
      title: String(get('title')).trim(),
      description: String(get('description') || '').trim() || undefined,
      category: String(get('category')).trim(),
      price_rub: Number.isFinite(price) ? price : 0,
      images,
      active,
      stock: Number.isFinite(stock) ? stock : undefined,
    }
    // простая валидация
    if (!item.title || !item.category || !item.slug) continue
    out.push(item)
  }
  return out
}


