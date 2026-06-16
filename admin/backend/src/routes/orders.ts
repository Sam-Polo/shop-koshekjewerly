import express from 'express'
import axios from 'axios'
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

// POST /api/orders/:orderId/notify-shipped — отбивка покупателю об отправке
router.post('/:orderId/notify-shipped', async (req, res) => {
  try {
    const { orderId } = req.params
    const backendUrl = process.env.BACKEND_URL || 'https://shop-koshekjewerly.onrender.com'
    const adminKey = process.env.ADMIN_IMPORT_KEY
    if (!adminKey) {
      return res.status(500).json({ error: 'ADMIN_IMPORT_KEY not configured' })
    }
    const response = await axios.post(
      `${backendUrl}/admin/notify-shipped`,
      { orderId },
      { headers: { 'x-admin-key': adminKey }, timeout: 20000 }
    )
    return res.json(response.data)
  } catch (error: any) {
    const status = error?.response?.status
    const data = error?.response?.data
    if (status === 404) return res.status(404).json({ error: 'order_not_found' })
    if (status === 422) return res.status(422).json({ error: data?.error || 'no_chat_id' })
    if (status === 502) return res.status(502).json({ error: 'send_failed' })
    logger.error({ error: error?.message }, 'ошибка отбивки покупателю')
    return res.status(500).json({ error: error?.message || 'failed' })
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
