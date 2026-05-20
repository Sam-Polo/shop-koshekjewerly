import express from 'express'
import { requireAuth } from '../auth.js'
import { loadFullOrders, type FullOrder } from '../orders-utils.js'
import pino from 'pino'

const logger = pino()
const router = express.Router()

router.use(requireAuth)

function parseTs(s: string): number {
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// GET /api/stats?from=&to=&platform=&category=
router.get('/', async (req, res) => {
  try {
    const { from, to, platform, category } = req.query as Record<string, string>
    const all = await loadFullOrders()

    const fromTs = from ? parseTs(from) : 0
    const toTs = to ? parseTs(to) : Number.MAX_SAFE_INTEGER

    // в статистику попадают только оплаченные заказы (pending/failed/cancelled не учитываем)
    const filtered = all.filter(o => {
      if (o.status !== 'paid') return false
      const t = parseTs(o.createdAt)
      if (t < fromTs || t > toTs) return false
      if (platform && o.platform !== platform) return false
      if (category && !o.items.some(i => i.category === category)) return false
      return true
    })

    // KPI
    const ordersCount = filtered.length
    const revenue = filtered.reduce((s, o) => s + o.total, 0)
    const avgCheck = ordersCount > 0 ? revenue / ordersCount : 0

    // Временной ряд по дням
    const byDay = new Map<string, { revenue: number; orders: number }>()
    for (const o of filtered) {
      const k = dayKey(parseTs(o.createdAt))
      const cur = byDay.get(k) || { revenue: 0, orders: 0 }
      cur.revenue += o.total
      cur.orders += 1
      byDay.set(k, cur)
    }
    const timeline = Array.from(byDay.entries())
      .map(([date, v]) => ({ date, revenue: v.revenue, orders: v.orders }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // Платформа (TG/MAX)
    const platformMap = new Map<string, { revenue: number; orders: number }>()
    for (const o of filtered) {
      const p = o.platform || 'telegram'
      const cur = platformMap.get(p) || { revenue: 0, orders: 0 }
      cur.revenue += o.total
      cur.orders += 1
      platformMap.set(p, cur)
    }
    const byPlatform = Array.from(platformMap.entries())
      .map(([key, v]) => ({ platform: key, revenue: v.revenue, orders: v.orders }))

    // Сравнение категорий (исключаем constructor)
    const categoryMap = new Map<string, { revenue: number; quantity: number }>()
    for (const o of filtered) {
      for (const it of o.items) {
        if (!it.category || it.category === 'constructor') continue
        const cur = categoryMap.get(it.category) || { revenue: 0, quantity: 0 }
        cur.revenue += it.price * it.quantity
        cur.quantity += it.quantity
        categoryMap.set(it.category, cur)
      }
    }
    const byCategory = Array.from(categoryMap.entries())
      .map(([key, v]) => ({ category: key, revenue: v.revenue, quantity: v.quantity }))
      .sort((a, b) => b.revenue - a.revenue)

    // Топ товаров (исключаем constructor)
    const productMap = new Map<string, { title: string; article: string; revenue: number; quantity: number; category: string }>()
    for (const o of filtered) {
      for (const it of o.items) {
        if (it.category === 'constructor') continue
        const cur = productMap.get(it.slug) || { title: it.title, article: it.article, revenue: 0, quantity: 0, category: it.category }
        cur.revenue += it.price * it.quantity
        cur.quantity += it.quantity
        cur.title = it.title
        cur.article = it.article
        productMap.set(it.slug, cur)
      }
    }
    const topProducts = Array.from(productMap.entries())
      .map(([slug, v]) => ({ slug, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)

    res.json({
      kpi: { revenue, ordersCount, avgCheck },
      timeline,
      byPlatform,
      byCategory,
      topProducts,
    })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка построения статистики')
    res.status(500).json({ error: error?.message || 'failed' })
  }
})

// GET /api/stats/categories  — список ключей категорий для фильтра (без constructor)
router.get('/categories', async (_req, res) => {
  try {
    const all = await loadFullOrders()
    const set = new Set<string>()
    for (const o of all) for (const it of o.items) {
      if (it.category && it.category !== 'constructor') set.add(it.category)
    }
    res.json({ categories: Array.from(set).sort() })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки списка категорий')
    res.status(500).json({ error: error?.message || 'failed' })
  }
})

export default router
