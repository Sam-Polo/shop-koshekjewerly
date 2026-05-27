import express from 'express'
import { requireAuth } from '../auth.js'
import { loadFullOrders, updateOrderNote, type FullOrder } from '../orders-utils.js'
import pino from 'pino'

const logger = pino()
const router = express.Router()

router.use(requireAuth)

function parseTs(s: string): number {
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

function matchesSearch(order: FullOrder, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  const hay = [
    order.orderId, order.fullName, order.phone, order.username,
    order.customerName, order.customerChatId, order.city, order.address,
    order.adminNote, order.clientComment, order.promocodeCode,
    ...order.items.map(i => `${i.title} ${i.article} ${i.slug}`)
  ].join(' ').toLowerCase()
  return hay.includes(needle)
}

// GET /api/orders?from=&to=&platform=&category=&status=&search=&hasNote=
router.get('/', async (req, res) => {
  try {
    const { from, to, platform, category, status, search, hasNote } = req.query as Record<string, string>
    const all = await loadFullOrders()

    const fromTs = from ? parseTs(from) : 0
    const toTs = to ? parseTs(to) : Number.MAX_SAFE_INTEGER

    const filtered = all.filter(o => {
      const t = parseTs(o.createdAt)
      if (t < fromTs || t > toTs) return false
      if (platform && o.platform !== platform) return false
      if (category && !o.items.some(i => i.category === category)) return false
      if (status && o.status !== status) return false
      if (hasNote === 'true' && !o.adminNote.trim()) return false
      if (hasNote === 'false' && o.adminNote.trim()) return false
      if (search && !matchesSearch(o, search)) return false
      return true
    })

    filtered.sort((a, b) => parseTs(b.createdAt) - parseTs(a.createdAt))
    res.json({ orders: filtered })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки заказов')
    res.status(500).json({ error: error?.message || 'failed' })
  }
})

// PATCH /api/orders/:orderId/note  { note: string }
router.patch('/:orderId/note', async (req, res) => {
  try {
    const { orderId } = req.params
    const note = typeof req.body?.note === 'string' ? req.body.note : ''
    const ok = await updateOrderNote(orderId, note)
    if (!ok) return res.status(404).json({ error: 'order_not_found' })
    res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка обновления заметки')
    res.status(500).json({ error: error?.message || 'failed' })
  }
})

export default router
