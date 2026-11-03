import express from 'express'
import axios from 'axios'
import { requireAuth } from '../auth.js'
import { invalidateOrdersCache } from '../orders-utils.js'
import pino from 'pino'

// Раздел EMS: всё, что касается Почты, делает основной бэкенд (Render) — креды Почты
// живут только там. Админка лишь проксирует с x-admin-key, как отбивку «отправлен».

const logger = pino()
const router = express.Router()

router.use(requireAuth)

function backend() {
  const url = (process.env.BACKEND_URL || 'https://shop-koshekjewerly.onrender.com').replace(/\/$/, '')
  const key = process.env.ADMIN_IMPORT_KEY
  return { url, key }
}

/** Пробрасывает ответ основного бэкенда как есть: в теле — текст для менеджера. */
function relayError(res: express.Response, error: any, what: string) {
  const status = error?.response?.status
  const data = error?.response?.data
  if (status === 401) {
    // ключ admin-backend не совпал с ADMIN_IMPORT_KEY основного бэкенда (Render)
    logger.error(`${what}: 401 от основного бэкенда — ADMIN_IMPORT_KEY не совпадает с Render`)
    return res.status(500).json({ error: 'admin_key_mismatch' })
  }
  if (status && data && typeof data === 'object') return res.status(status).json(data)
  logger.error({ status, error: error?.message }, `${what}: основной бэкенд не ответил`)
  return res.status(502).json({ error: 'backend_unavailable', detail: error?.message })
}

// GET /api/ems — EMS-заказы со статусом у Почты
router.get('/', async (_req, res) => {
  const { url, key } = backend()
  if (!key) return res.status(500).json({ error: 'ADMIN_IMPORT_KEY not configured' })
  try {
    const r = await axios.get(`${url}/admin/pochta/orders`, { headers: { 'x-admin-key': key }, timeout: 60_000 })
    res.json(r.data)
  } catch (error: any) {
    relayError(res, error, 'EMS-список')
  }
})

// GET /api/ems/countries — справочник стран Почты (для формы заказа вне мини-аппа)
router.get('/countries', async (_req, res) => {
  const { url } = backend()
  try {
    const r = await axios.get(`${url}/api/pochta/countries`, { timeout: 20_000 })
    res.json(r.data)
  } catch (error: any) {
    relayError(res, error, 'EMS-страны')
  }
})

// POST /api/ems/:orderId/ship { sendingDate } — назначить или перенести дату отправки.
// Бэкенд ждёт Почту до 45 с и потом отвечает «ещё в процессе» — таймаут прокси с запасом.
router.post('/:orderId/ship', async (req, res) => {
  const { url, key } = backend()
  if (!key) return res.status(500).json({ error: 'ADMIN_IMPORT_KEY not configured' })
  const sendingDate = typeof req.body?.sendingDate === 'string' ? req.body.sendingDate : ''
  try {
    const r = await axios.post(
      `${url}/admin/pochta/ship`,
      { orderId: req.params.orderId, sendingDate },
      { headers: { 'x-admin-key': key }, timeout: 70_000 },
    )
    // трек и заметка пишутся в orders — кэш списка заказов админки больше не актуален
    invalidateOrdersCache()
    res.status(r.status).json(r.data)
  } catch (error: any) {
    relayError(res, error, 'EMS-отправка')
  }
})

// POST /api/ems/manual-order — оплаченный EMS-заказ, пришедший не через мини-апп
router.post('/manual-order', async (req, res) => {
  const { url, key } = backend()
  if (!key) return res.status(500).json({ error: 'ADMIN_IMPORT_KEY not configured' })
  try {
    const r = await axios.post(`${url}/admin/orders/manual`, req.body ?? {}, {
      headers: { 'x-admin-key': key }, timeout: 90_000,
    })
    invalidateOrdersCache()
    res.json(r.data)
  } catch (error: any) {
    relayError(res, error, 'EMS-ручной заказ')
  }
})

export default router
