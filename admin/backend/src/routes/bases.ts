import express from 'express'
import { randomUUID } from 'node:crypto'
import { requireAuth } from '../auth.js'
import { fetchBasesFromSheet, saveBasesToSheet, type Base } from '../bases-utils.js'
import pino from 'pino'
import axios from 'axios'

const logger = pino()
const router = express.Router()

async function triggerBackendImport() {
  try {
    const backendUrl = process.env.BACKEND_URL || 'https://shop-koshekjewerly.onrender.com'
    const adminKey = process.env.ADMIN_IMPORT_KEY
    if (adminKey) {
      await axios.post(`${backendUrl}/admin/import/sheets`, {}, {
        headers: { 'x-admin-key': adminKey },
        timeout: 30000
      })
      logger.info('импорт в основном бэкенде вызван')
    }
  } catch (error: any) {
    logger.warn({ error: error?.message }, 'не удалось вызвать импорт в основном бэкенде')
  }
}

function sanitizeLimit(v: any): number | null {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

router.use(requireAuth)

router.get('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    const bases = await fetchBasesFromSheet(sheetId)
    return res.json({ bases })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки основ')
    return res.status(500).json({ error: error?.message || 'Ошибка загрузки основ' })
  }
})

router.put('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })

    const { bases } = req.body
    if (!Array.isArray(bases)) {
      return res.status(400).json({ error: 'bases must be an array' })
    }

    const valid: Base[] = []
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i]
      if (!b || typeof b.title !== 'string' || !b.title.trim()) continue

      const for_necklace = !!b.for_necklace
      const for_earrings = !!b.for_earrings
      const for_bracelet = !!b.for_bracelet

      // как минимум один тип должен быть выбран
      if (!for_necklace && !for_earrings && !for_bracelet) {
        return res.status(400).json({ error: 'base_must_have_at_least_one_type', title: b.title })
      }

      const price = Number(b.price)
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'invalid_price', title: b.title })
      }

      // images: массив URL (1..20). Поддерживаем back-compat: одиночный image тоже принимаем.
      let images: string[] = []
      if (Array.isArray(b.images)) {
        images = b.images.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
      } else if (typeof b.image === 'string' && b.image.trim()) {
        images = [b.image.trim()]
      }
      if (images.length === 0) {
        return res.status(400).json({ error: 'images_required', title: b.title })
      }
      if (images.length > 20) {
        return res.status(400).json({ error: 'too_many_images', title: b.title })
      }
      for (const img of images) {
        try { new URL(img) } catch {
          return res.status(400).json({ error: 'invalid_image_url_format', title: b.title })
        }
      }

      valid.push({
        id: typeof b.id === 'string' && b.id.trim() ? b.id.trim() : randomUUID(),
        title: b.title.trim(),
        description: typeof b.description === 'string' ? b.description.trim() || undefined : undefined,
        images,
        price,
        for_necklace,
        for_earrings,
        for_bracelet,
        limit_necklace: for_necklace ? sanitizeLimit(b.limit_necklace) : null,
        limit_earrings: for_earrings ? sanitizeLimit(b.limit_earrings) : null,
        limit_bracelet: for_bracelet ? sanitizeLimit(b.limit_bracelet) : null,
        active: b.active !== false,
        order: i
      })
    }

    await saveBasesToSheet(sheetId, valid)
    await triggerBackendImport()
    return res.json({ success: true, bases: valid })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения основ')
    return res.status(500).json({ error: error?.message || 'Ошибка сохранения основ' })
  }
})

export default router
