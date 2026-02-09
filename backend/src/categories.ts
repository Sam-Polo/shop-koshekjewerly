import { google } from 'googleapis'
import fs from 'node:fs'

export type Category = {
  key: string
  title: string
  description?: string
  image: string
  image_position?: string
  order: number
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

const SHEET_NAME = 'categories'

export async function fetchCategoriesFromSheet(sheetId: string): Promise<Category[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  try {
    const range = `${SHEET_NAME}!A1:F500`
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
    const rows = res.data.values ?? []

    if (rows.length < 2) return []

    const header = rows[0].map((h: string) => h.trim().toLowerCase())
    const idx = (name: string) => header.indexOf(name)

    const categories: Category[] = []
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length === 0) continue

      const get = (n: string) => String(r[idx(n)] ?? '').trim()
      const key = get('key')
      if (!key) continue

      const order = parseInt(get('order'), 10)
      categories.push({
        key,
        title: get('title') || key,
        description: get('description') || undefined,
        image: get('image') || '',
        image_position: get('image_position') || 'center',
        order: Number.isFinite(order) ? order : i
      })
    }

    categories.sort((a, b) => a.order - b.order)
    return categories
  } catch (e: any) {
    if (e?.message?.includes('Unable to parse range') || e?.code === 400) {
      return []
    }
    throw e
  }
}
