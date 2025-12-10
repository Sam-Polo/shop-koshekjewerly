import express from 'express'
import { requireAuth } from '../auth.js'
import {
  fetchOrdersSettingsFromSheet,
  saveOrdersSettingsToSheet
} from '../settings-utils.js'
import pino from 'pino'

const logger = pino()
const router = express.Router()

// все роуты требуют авторизации
router.use(requireAuth)

// получение настроек заказов
router.get('/orders-status', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }
    
    logger.info('загрузка настроек заказов из Google Sheets')
    const settings = await fetchOrdersSettingsFromSheet(sheetId)
    logger.info({ ordersClosed: settings.ordersClosed, closeDate: settings.closeDate }, 'настройки заказов загружены')
    
    return res.json(settings)
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки настроек заказов')
    return res.status(500).json({ error: error?.message || 'Ошибка загрузки настроек заказов' })
  }
})

// обновление настроек заказов
router.put('/orders-status', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }
    
    const { ordersClosed, closeDate } = req.body
    
    // валидация
    if (typeof ordersClosed !== 'boolean') {
      return res.status(400).json({ error: 'ordersClosed must be a boolean' })
    }
    
    if (closeDate !== undefined && closeDate !== null && closeDate !== '') {
      // проверяем формат даты (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/
      if (!dateRegex.test(closeDate)) {
        return res.status(400).json({ error: 'closeDate must be in format YYYY-MM-DD' })
      }
    }
    
    logger.info({ ordersClosed, closeDate }, 'сохранение настроек заказов')
    
    await saveOrdersSettingsToSheet(sheetId, {
      ordersClosed,
      closeDate: closeDate || undefined
    })
    
    logger.info('настройки заказов сохранены')
    
    return res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения настроек заказов')
    return res.status(500).json({ error: error?.message || 'Ошибка сохранения настроек заказов' })
  }
})

export default router


