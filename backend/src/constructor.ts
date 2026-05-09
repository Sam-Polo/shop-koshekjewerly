import { google } from 'googleapis'
import fs from 'node:fs'

export type JewelryType = 'necklace' | 'earrings' | 'bracelet'

export const JEWELRY_TYPES: { key: JewelryType; title: string }[] = [
  { key: 'necklace', title: 'Колье' },
  { key: 'earrings', title: 'Серьги' },
  { key: 'bracelet', title: 'Браслет' }
]

export type Base = {
  id: string
  title: string
  description?: string
  images: string[]
  price: number
  for_necklace: boolean
  for_earrings: boolean
  for_bracelet: boolean
  /** Лимит подвесок для типа: число — максимум, 0 — без ограничения, null — по умолчанию = 1 */
  limit_necklace: number | null
  limit_earrings: number | null
  limit_bracelet: number | null
  article?: string
  badge_text?: string
  active: boolean
  order: number
}

export type Pendant = {
  id: string
  title: string
  description?: string
  images: string[]
  price: number
  for_necklace: boolean
  for_earrings: boolean
  for_bracelet: boolean
  article?: string
  badge_text?: string
  /** Съёмная или нет. Если в сборку добавлены не-съёмные — лимит подвесок становится 2. */
  removable: boolean
  active: boolean
  order: number
}

function parseImages(raw: string): string[] {
  return raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
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

function parseBool(v: any): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'да'
}

function parseLimit(v: any): number | null {
  const s = String(v ?? '').trim()
  if (s === '') return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export async function fetchBasesFromSheet(sheetId: string): Promise<Base[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'bases!A1:M1000'
    })
    const rows = res.data.values ?? []
    if (rows.length < 2) return []

    const header = rows[0].map((h: string) => h.trim().toLowerCase())
    const idx = (n: string) => header.indexOf(n)

    const out: Base[] = []
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length === 0) continue
      const get = (n: string) => String(r[idx(n)] ?? '').trim()
      const id = get('id')
      if (!id) continue

      const imagesRaw = get('images') || get('image')
      out.push({
        id,
        title: get('title') || id,
        description: get('description') || undefined,
        images: imagesRaw ? parseImages(imagesRaw) : [],
        price: Number(get('price')) || 0,
        for_necklace: parseBool(get('for_necklace')),
        for_earrings: parseBool(get('for_earrings')),
        for_bracelet: parseBool(get('for_bracelet')),
        limit_necklace: parseLimit(get('limit_necklace')),
        limit_earrings: parseLimit(get('limit_earrings')),
        limit_bracelet: parseLimit(get('limit_bracelet')),
        article: get('article') || undefined,
        badge_text: get('badge_text') || undefined,
        active: parseBool(get('active')),
        order: parseInt(get('order'), 10) || i
      })
    }
    out.sort((a, b) => a.order - b.order)
    return out
  } catch (e: any) {
    if (e?.message?.includes('Unable to parse range') || e?.code === 400) return []
    throw e
  }
}

export async function fetchPendantsFromSheet(sheetId: string): Promise<Pendant[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'pendants!A1:J1000'
    })
    const rows = res.data.values ?? []
    if (rows.length < 2) return []

    const header = rows[0].map((h: string) => h.trim().toLowerCase())
    const idx = (n: string) => header.indexOf(n)

    const out: Pendant[] = []
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length === 0) continue
      const get = (n: string) => String(r[idx(n)] ?? '').trim()
      const id = get('id')
      if (!id) continue

      const imagesRaw = get('images') || get('image')
      const removableRaw = String(rows[i][idx('removable')] ?? '').trim().toLowerCase()
      out.push({
        id,
        title: get('title') || id,
        description: get('description') || undefined,
        images: imagesRaw ? parseImages(imagesRaw) : [],
        price: Number(get('price')) || 0,
        for_necklace: parseBool(get('for_necklace')),
        for_earrings: parseBool(get('for_earrings')),
        for_bracelet: parseBool(get('for_bracelet')),
        article: get('article') || undefined,
        badge_text: get('badge_text') || undefined,
        // back-compat: пустая ячейка считается «съёмной» (true)
        removable: removableRaw === '' ? true : (removableRaw === 'true' || removableRaw === '1' || removableRaw === 'yes' || removableRaw === 'да'),
        active: parseBool(get('active')),
        order: parseInt(get('order'), 10) || i
      })
    }
    out.sort((a, b) => a.order - b.order)
    return out
  } catch (e: any) {
    if (e?.message?.includes('Unable to parse range') || e?.code === 400) return []
    throw e
  }
}

// in-memory cache (как у products в store.ts)
const cache = {
  bases: [] as Base[],
  pendants: [] as Pendant[]
}

export function setCachedBases(items: Base[]) { cache.bases = items }
export function setCachedPendants(items: Pendant[]) { cache.pendants = items }
export function getCachedBases() { return cache.bases }
export function getCachedPendants() { return cache.pendants }

// helpers для фильтрации по типу украшения
export function basesForType(type: JewelryType): Base[] {
  return cache.bases.filter(b => b.active && (
    type === 'necklace' ? b.for_necklace :
    type === 'earrings' ? b.for_earrings :
    b.for_bracelet
  ))
}

export function pendantsForType(type: JewelryType): Pendant[] {
  return cache.pendants.filter(p => p.active && (
    type === 'necklace' ? p.for_necklace :
    type === 'earrings' ? p.for_earrings :
    p.for_bracelet
  ))
}

/** Возвращает лимит подвесок основы для типа. null = по умолчанию = 1, 0 = без лимита, N = максимум */
export function getBaseLimit(base: Base, type: JewelryType): number | null {
  return type === 'necklace' ? base.limit_necklace
       : type === 'earrings' ? base.limit_earrings
       : base.limit_bracelet
}

/** Эффективный лимит для валидации: null → 1, иначе как есть */
export function effectiveLimit(base: Base, type: JewelryType): number {
  const raw = getBaseLimit(base, type)
  return raw == null ? 1 : raw
}
