import express from 'express'
import { requireAuth } from '../auth.js'
import { loadFullOrders, type FullOrder } from '../orders-utils.js'
import pino from 'pino'

const logger = pino()
const router = express.Router()

router.use(requireAuth)

export type CustomerAggregate = {
  id: string
  fullName: string
  phone: string
  username: string
  customerChatId: string
  platform: string
  ordersCount: number
  totalSpent: number
  firstOrderAt: string
  lastOrderAt: string
  lastAddress: string
  lastCity: string
  lastCountry: string
}

function parseTs(s: string): number {
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

function customerKey(o: FullOrder): string {
  if (o.customerChatId) return `cid:${o.customerChatId}`
  if (o.phone) return `phone:${o.phone}`
  if (o.fullName) return `name:${o.fullName.toLowerCase()}`
  return `ord:${o.orderId}`
}

function aggregate(orders: FullOrder[]): CustomerAggregate[] {
  const byKey = new Map<string, FullOrder[]>()
  for (const o of orders) {
    const k = customerKey(o)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(o)
  }
  const out: CustomerAggregate[] = []
  for (const [key, list] of byKey.entries()) {
    list.sort((a, b) => parseTs(a.createdAt) - parseTs(b.createdAt))
    const first = list[0]
    const last = list[list.length - 1]
    // считаем только оплаченные для total — нет, юзер просил «все заказы без статусов»
    const totalSpent = list.reduce((s, o) => s + o.total, 0)
    out.push({
      id: key,
      fullName: last.fullName || first.fullName,
      phone: last.phone || first.phone,
      username: last.username || first.username,
      customerChatId: last.customerChatId || first.customerChatId,
      platform: last.platform,
      ordersCount: list.length,
      totalSpent,
      firstOrderAt: first.createdAt,
      lastOrderAt: last.createdAt,
      lastAddress: last.address,
      lastCity: last.city,
      lastCountry: last.country,
    })
  }
  out.sort((a, b) => parseTs(b.lastOrderAt) - parseTs(a.lastOrderAt))
  return out
}

function matchesSearch(c: CustomerAggregate, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  const hay = [c.fullName, c.phone, c.username, c.customerChatId, c.lastCity].join(' ').toLowerCase()
  return hay.includes(needle)
}

// GET /api/customers?search=
router.get('/', async (req, res) => {
  try {
    const { search } = req.query as Record<string, string>
    const all = await loadFullOrders()
    let customers = aggregate(all)
    if (search) customers = customers.filter(c => matchesSearch(c, search))
    res.json({ customers })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки клиентов')
    res.status(500).json({ error: error?.message || 'failed' })
  }
})

// GET /api/customers/:id/orders
router.get('/:id/orders', async (req, res) => {
  try {
    const { id } = req.params
    const all = await loadFullOrders()
    const orders = all.filter(o => customerKey(o) === id)
    orders.sort((a, b) => parseTs(b.createdAt) - parseTs(a.createdAt))
    res.json({ orders })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки заказов клиента')
    res.status(500).json({ error: error?.message || 'failed' })
  }
})

export default router
