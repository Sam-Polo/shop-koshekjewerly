import express from 'express'
import { requireAuth } from '../auth.js'
import { fetchProductsFromSheet } from '../sheets.js'
import { fetchBasesFromSheet } from '../bases-utils.js'
import { fetchPendantsFromSheet } from '../pendants-utils.js'
import pino from 'pino'

const logger = pino()
const router = express.Router()

router.use(requireAuth)

// возвращает следующий доступный артикул (max + 1) среди всех товаров, основ и подвесок
router.get('/next', async (_req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })

    const [products, bases, pendants] = await Promise.all([
      fetchProductsFromSheet(sheetId),
      fetchBasesFromSheet(sheetId),
      fetchPendantsFromSheet(sheetId)
    ])

    const articles: number[] = []
    const collect = (raw: string | undefined) => {
      if (!raw) return
      const s = String(raw).trim()
      if (!/^\d{1,4}$/.test(s)) return
      const n = parseInt(s, 10)
      if (Number.isFinite(n) && n >= 0 && n <= 9999) articles.push(n)
    }
    products.forEach(p => collect(p.article))
    bases.forEach(b => collect(b.article))
    pendants.forEach(p => collect(p.article))

    const next = (articles.length === 0 ? 1 : Math.max(...articles) + 1)
    const formatted = String(next).padStart(4, '0')
    return res.json({ next: formatted })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка получения следующего артикула')
    return res.status(500).json({ error: error?.message || 'failed_to_get_next_article' })
  }
})

export default router
