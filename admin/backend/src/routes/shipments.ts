import express from 'express'
import { requireAuth } from '../auth.js'
import { buildShipmentsReport } from '../shipment-items-utils.js'
import pino from 'pino'

const logger = pino()
const router = express.Router()

router.use(requireAuth)

// GET /api/shipments?from=YYYY-MM-DD&to=YYYY-MM-DD&source=telegram|tilda|max
router.get('/', async (req, res) => {
  try {
    const { from, to, source } = req.query as Record<string, string>
    const report = await buildShipmentsReport({ from, to, source })
    res.json(report)
  } catch (e: any) {
    logger.error({ err: e?.message, stack: e?.stack }, 'shipments report error')
    res.status(500).json({ error: 'internal_error', detail: e?.message })
  }
})

export default router
