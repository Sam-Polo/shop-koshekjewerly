import express from 'express'
import { requireAuth } from '../auth.js'
import {
  fetchOrdersSettingsFromSheet,
  saveOrdersSettingsToSheet,
  fetchBannerSettingsFromSheet,
  saveBannerSettingsToSheet
} from '../settings-utils.js'
import pino from 'pino'
import axios from 'axios'

const logger = pino()
const router = express.Router()

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
      logger.info('импорт настроек в основном бэкенде вызван')
    } else {
      logger.warn('ADMIN_IMPORT_KEY не задан, импорт в основном бэкенде пропущен')
    }
  } catch (error: any) {
    logger.warn({ error: error?.message }, 'не удалось вызвать импорт в основном бэкенде')
  }
}

// все роуты требуют авторизации
router.use(requireAuth)

// получение настроек заказов
router.get('/orders-status', async (_req, res) => {
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

    const { ordersClosed, closeDate, assemblyMessage, trackMessage, shippedMessage, assembledMessage, priorityOrderEnabled, priorityOrderFee } = req.body

    if (typeof ordersClosed !== 'boolean') {
      return res.status(400).json({ error: 'ordersClosed must be a boolean' })
    }

    if (closeDate !== undefined && closeDate !== null && closeDate !== '') {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/
      if (!dateRegex.test(closeDate)) {
        return res.status(400).json({ error: 'closeDate must be in format YYYY-MM-DD' })
      }
    }

    if (assemblyMessage !== undefined && typeof assemblyMessage !== 'string') {
      return res.status(400).json({ error: 'assemblyMessage must be a string' })
    }

    if (trackMessage !== undefined && typeof trackMessage !== 'string') {
      return res.status(400).json({ error: 'trackMessage must be a string' })
    }

    if (shippedMessage !== undefined && typeof shippedMessage !== 'string') {
      return res.status(400).json({ error: 'shippedMessage must be a string' })
    }

    if (assembledMessage !== undefined && typeof assembledMessage !== 'string') {
      return res.status(400).json({ error: 'assembledMessage must be a string' })
    }

    if (priorityOrderFee !== undefined) {
      const fee = Number(priorityOrderFee)
      if (!Number.isInteger(fee) || fee < 1 || fee > 100) {
        return res.status(400).json({ error: 'priorityOrderFee must be an integer 1–100' })
      }
    }

    logger.info({ ordersClosed, closeDate }, 'сохранение настроек заказов')
    await saveOrdersSettingsToSheet(sheetId, {
      ordersClosed,
      closeDate: closeDate || undefined,
      assemblyMessage: assemblyMessage || undefined,
      trackMessage: trackMessage || undefined,
      shippedMessage: shippedMessage || undefined,
      assembledMessage: assembledMessage || undefined,
      priorityOrderEnabled: priorityOrderEnabled !== false,
      priorityOrderFee: priorityOrderFee !== undefined ? Number(priorityOrderFee) : undefined
    })
    logger.info('настройки заказов сохранены')

    await triggerBackendImport()

    return res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения настроек заказов')
    return res.status(500).json({ error: error?.message || 'Ошибка сохранения настроек заказов' })
  }
})

// получение настроек баннера
router.get('/banner', async (_req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    logger.info('загрузка настроек баннера из Google Sheets')
    const banner = await fetchBannerSettingsFromSheet(sheetId)
    logger.info({ banner }, 'настройки баннера загружены')

    return res.json(banner)
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки настроек баннера')
    return res.status(500).json({ error: error?.message || 'Ошибка загрузки настроек баннера' })
  }
})

// обновление настроек баннера
router.put('/banner', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const { bannerEnabled, bannerText, bannerStyle, bannerDateFrom, bannerDateTo } = req.body

    if (typeof bannerEnabled !== 'boolean') {
      return res.status(400).json({ error: 'bannerEnabled must be a boolean' })
    }

    if (typeof bannerText !== 'string') {
      return res.status(400).json({ error: 'bannerText must be a string' })
    }

    const validStyles = ['pink', 'gold', 'neutral']
    if (!validStyles.includes(bannerStyle)) {
      return res.status(400).json({ error: 'bannerStyle must be pink, gold, or neutral' })
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (bannerDateFrom && !dateRegex.test(bannerDateFrom)) {
      return res.status(400).json({ error: 'bannerDateFrom must be in format YYYY-MM-DD' })
    }
    if (bannerDateTo && !dateRegex.test(bannerDateTo)) {
      return res.status(400).json({ error: 'bannerDateTo must be in format YYYY-MM-DD' })
    }

    logger.info({ bannerEnabled, bannerStyle }, 'сохранение настроек баннера')
    await saveBannerSettingsToSheet(sheetId, {
      bannerEnabled,
      bannerText,
      bannerStyle,
      bannerDateFrom: bannerDateFrom || undefined,
      bannerDateTo: bannerDateTo || undefined
    })
    logger.info('настройки баннера сохранены')

    await triggerBackendImport()

    return res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения настроек баннера')
    return res.status(500).json({ error: error?.message || 'Ошибка сохранения настроек баннера' })
  }
})

export default router
