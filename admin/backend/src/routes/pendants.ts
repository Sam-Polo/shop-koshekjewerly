import express from 'express'
import { randomUUID } from 'node:crypto'
import { requireAuth } from '../auth.js'
import { fetchPendantsFromSheet, savePendantsToSheet, type Pendant } from '../pendants-utils.js'
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

router.use(requireAuth)

router.get('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    const pendants = await fetchPendantsFromSheet(sheetId)
    return res.json({ pendants })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки подвесок')
    return res.status(500).json({ error: error?.message || 'Ошибка загрузки подвесок' })
  }
})

router.put('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })

    const { pendants } = req.body
    if (!Array.isArray(pendants)) {
      return res.status(400).json({ error: 'pendants must be an array' })
    }

    const valid: Pendant[] = []
    for (let i = 0; i < pendants.length; i++) {
      const p = pendants[i]
      if (!p || typeof p.title !== 'string' || !p.title.trim()) continue

      const for_necklace = !!p.for_necklace
      const for_earrings = !!p.for_earrings
      const for_bracelet = !!p.for_bracelet

      if (!for_necklace && !for_earrings && !for_bracelet) {
        return res.status(400).json({ error: 'pendant_must_have_at_least_one_type', title: p.title })
      }

      const price = Number(p.price)
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'invalid_price', title: p.title })
      }

      let images: string[] = []
      if (Array.isArray(p.images)) {
        images = p.images.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
      } else if (typeof p.image === 'string' && p.image.trim()) {
        images = [p.image.trim()]
      }
      if (images.length === 0) {
        return res.status(400).json({ error: 'images_required', title: p.title })
      }
      if (images.length > 20) {
        return res.status(400).json({ error: 'too_many_images', title: p.title })
      }
      for (const img of images) {
        try { new URL(img) } catch {
          return res.status(400).json({ error: 'invalid_image_url_format', title: p.title })
        }
      }

      valid.push({
        id: typeof p.id === 'string' && p.id.trim() ? p.id.trim() : randomUUID(),
        title: p.title.trim(),
        description: typeof p.description === 'string' ? p.description.trim() || undefined : undefined,
        images,
        price,
        for_necklace,
        for_earrings,
        for_bracelet,
        active: p.active !== false,
        order: i
      })
    }

    await savePendantsToSheet(sheetId, valid)
    await triggerBackendImport()
    return res.json({ success: true, pendants: valid })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения подвесок')
    return res.status(500).json({ error: error?.message || 'Ошибка сохранения подвесок' })
  }
})

export default router
