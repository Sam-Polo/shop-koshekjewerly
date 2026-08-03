import express from 'express'
import { requireAuth } from '../auth.js'
import {
  fetchOrdersSettingsFromSheet,
  saveOrdersSettingsToSheet,
  fetchBannerSettingsFromSheet,
  saveBannerSettingsToSheet,
  fetchFaqFromSheet,
  saveFaqToSheet
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

    const { ordersClosed, closeDate, assemblyMessage, trackMessage, shippedMessage, assembledMessage, priorityOrderEnabled, priorityOrderFee, pickupEnabled, cdekMarkupPercent } = req.body

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

    if (cdekMarkupPercent !== undefined) {
      const markup = Number(cdekMarkupPercent)
      if (!Number.isInteger(markup) || markup < 0 || markup > 100) {
        return res.status(400).json({ error: 'cdekMarkupPercent must be an integer 0–100' })
      }
    }

    logger.info({ ordersClosed, closeDate, pickupEnabled, cdekMarkupPercent }, 'сохранение настроек заказов')
    await saveOrdersSettingsToSheet(sheetId, {
      ordersClosed,
      closeDate: closeDate || undefined,
      assemblyMessage: assemblyMessage || undefined,
      trackMessage: trackMessage || undefined,
      shippedMessage: shippedMessage || undefined,
      assembledMessage: assembledMessage || undefined,
      priorityOrderEnabled: priorityOrderEnabled !== false,
      priorityOrderFee: priorityOrderFee !== undefined ? Number(priorityOrderFee) : undefined,
      pickupEnabled: pickupEnabled !== false,
      cdekMarkupPercent: cdekMarkupPercent !== undefined ? Number(cdekMarkupPercent) : undefined
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

// получение FAQ
router.get('/faq', async (_req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }
    const items = await fetchFaqFromSheet(sheetId)
    return res.json({ items })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки FAQ')
    return res.status(500).json({ error: error?.message || 'Ошибка загрузки FAQ' })
  }
})

// сохранение FAQ (полная перезапись списка)
router.put('/faq', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const { items } = req.body
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items must be an array' })
    }
    if (items.length > 50) {
      return res.status(400).json({ error: 'too many items (max 50)' })
    }
    for (const it of items) {
      if (!it || typeof it.question !== 'string' || typeof it.answer !== 'string') {
        return res.status(400).json({ error: 'each item must have question and answer strings' })
      }
      if (!it.question.trim() || !it.answer.trim()) {
        return res.status(400).json({ error: 'question and answer must not be empty' })
      }
      if (it.question.length > 300 || it.answer.length > 3000) {
        return res.status(400).json({ error: 'question max 300 chars, answer max 3000 chars' })
      }
    }

    logger.info({ count: items.length }, 'сохранение FAQ')
    await saveFaqToSheet(sheetId, items.map((it: any) => ({
      question: it.question.trim(),
      answer: it.answer.trim()
    })))

    await triggerBackendImport()

    return res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения FAQ')
    return res.status(500).json({ error: error?.message || 'Ошибка сохранения FAQ' })
  }
})

export default router
