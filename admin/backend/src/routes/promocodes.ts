import express from 'express'
import { requireAuth } from '../auth.js'
import { getAuthFromEnv } from '../sheets-utils.js'
import {
  fetchPromocodesFromSheet,
  appendPromocodeToSheet,
  deletePromocodeFromSheet
} from '../promocodes-utils.js'
import pino from 'pino'
import axios from 'axios'

const logger = pino()
const router = express.Router()

// все роуты требуют авторизации
router.use(requireAuth)

// функция для вызова импорта в основном бэкенде
async function triggerBackendImport() {
  try {
    const backendUrl = process.env.BACKEND_URL || 'https://shop-koshekjewerly.onrender.com'
    const adminKey = process.env.ADMIN_IMPORT_KEY
    
    if (adminKey) {
      await axios.post(`${backendUrl}/admin/import/sheets`, {}, {
        headers: { 'x-admin-key': adminKey },
        timeout: 30000
      })
      logger.info('импорт промокодов в основном бэкенде вызван')
    } else {
      logger.warn('ADMIN_IMPORT_KEY не задан, импорт в основном бэкенде пропущен')
    }
  } catch (error: any) {
    logger.warn({ error: error?.message }, 'не удалось вызвать импорт в основном бэкенде')
  }
}

// получение списка всех промокодов
router.get('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }
    
    logger.info('загрузка промокодов из Google Sheets')
    const promocodes = await fetchPromocodesFromSheet(sheetId)
    logger.info({ count: promocodes.length }, 'промокоды загружены')
    
    res.json({ promocodes })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки промокодов')
    res.status(500).json({ error: 'failed_to_load_promocodes' })
  }
})

// добавление промокода
router.post('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const promocodeData = req.body

    // валидация
    if (!promocodeData.code || typeof promocodeData.code !== 'string') {
      return res.status(400).json({ error: 'invalid_code' })
    }

    const code = promocodeData.code.trim().toUpperCase()
    if (code.length < 3 || code.length > 50) {
      return res.status(400).json({ error: 'code_length_invalid' })
    }

    // проверка формата кода (только буквы, цифры, дефисы, подчеркивания)
    if (!/^[A-Z0-9_-]+$/.test(code)) {
      return res.status(400).json({ error: 'invalid_code_format' })
    }

    if (promocodeData.type !== 'amount' && promocodeData.type !== 'percent') {
      return res.status(400).json({ error: 'invalid_type' })
    }

    const value = Number(promocodeData.value)
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: 'invalid_value' })
    }

    if (promocodeData.type === 'percent' && value > 100) {
      return res.status(400).json({ error: 'percent_too_high' })
    }

    // проверка уникальности кода
    const allPromocodes = await fetchPromocodesFromSheet(sheetId)
    const codeExists = allPromocodes.some(p => p.code === code)
    if (codeExists) {
      return res.status(400).json({ error: 'code_already_exists' })
    }

    // парсим дату окончания
    let expiresAt: string | undefined = undefined
    if (promocodeData.expiresAt) {
      try {
        const date = new Date(promocodeData.expiresAt)
        if (isNaN(date.getTime())) {
          return res.status(400).json({ error: 'invalid_expires_at' })
        }
        expiresAt = date.toISOString()
      } catch (e) {
        return res.status(400).json({ error: 'invalid_expires_at' })
      }
    }

    const auth = getAuthFromEnv()
    
    const promocode = {
      code,
      type: promocodeData.type as 'amount' | 'percent',
      value,
      expiresAt,
      active: promocodeData.active !== undefined ? Boolean(promocodeData.active) : true
    }

    await appendPromocodeToSheet(auth, sheetId, promocode)

    logger.info({ code: promocode.code }, 'промокод добавлен')
    
    // вызываем импорт в основном бэкенде для обновления мини-апки
    await triggerBackendImport()
    
    res.json({ success: true, promocode })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка добавления промокода')
    res.status(500).json({ error: error?.message || 'failed_to_create_promocode' })
  }
})

// удаление промокода
router.delete('/:code', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const code = req.params.code.trim().toUpperCase()

    const auth = getAuthFromEnv()
    await deletePromocodeFromSheet(auth, sheetId, code)

    logger.info({ code }, 'промокод удален')
    
    // вызываем импорт в основном бэкенде для обновления мини-апки
    await triggerBackendImport()
    
    res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка удаления промокода')
    if (error.message === 'Промокод не найден') {
      return res.status(404).json({ error: 'promocode_not_found' })
    }
    res.status(500).json({ error: error?.message || 'failed_to_delete_promocode' })
  }
})

export default router

