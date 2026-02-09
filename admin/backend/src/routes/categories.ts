import express from 'express'
import { requireAuth } from '../auth.js'
import {
  fetchCategoriesFromSheet,
  saveCategoriesToSheet,
  type Category
} from '../categories-utils.js'
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

// получить все категории
router.get('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }
    const categories = await fetchCategoriesFromSheet(sheetId)
    return res.json({ categories })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки категорий')
    return res.status(500).json({ error: error?.message || 'Ошибка загрузки категорий' })
  }
})

// сохранить категории (полная перезапись)
router.put('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const { categories } = req.body
    if (!Array.isArray(categories)) {
      return res.status(400).json({ error: 'categories must be an array' })
    }

    const valid: Category[] = []
    for (let i = 0; i < categories.length; i++) {
      const c = categories[i]
      if (!c || typeof c.key !== 'string' || !c.key.trim()) continue
      if (typeof c.title !== 'string') continue
      if (typeof c.image !== 'string') c.image = ''

      valid.push({
        key: c.key.trim().toLowerCase(),
        title: (c.title || c.key).trim(),
        description: typeof c.description === 'string' ? c.description.trim() || undefined : undefined,
        image: (c.image || '').trim(),
        image_position: typeof c.image_position === 'string' ? c.image_position.trim() || 'center' : 'center',
        order: i
      })
    }

    await saveCategoriesToSheet(sheetId, valid)
    await triggerBackendImport()
    return res.json({ success: true, categories: valid })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения категорий')
    return res.status(500).json({ error: error?.message || 'Ошибка сохранения категорий' })
  }
})

export default router
