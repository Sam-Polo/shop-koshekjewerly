import type { Request, Response } from 'express'
import pino from 'pino'
import { sendAlert } from './alerts.js'
import { createOrderItemsIfNew, type ShipmentItem } from './shipment-items-sheet.js'
import { normalizeArticle } from './shipment-items-parser.js'

const logger = pino()

export function handleTildaOrder(req: Request, res: Response): void {
  res.sendStatus(200)

  const body: any = req.body
  if (body?.test === 'test') return

  logger.info({ body }, 'Tilda order webhook received')

  const payment: any = body?.payment
  if (!payment) return

  const products: any[] = payment?.products ?? []
  if (products.length === 0) return

  const orderId  = String(payment?.orderid ?? '').trim()
  const orderDate = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(0, 10)

  if (!orderId) {
    logger.warn({ body }, 'Tilda webhook: no orderid in payment')
    return
  }

  const items: ShipmentItem[] = []
  const skipped: string[] = []

  for (const p of products) {
    const sku = normalizeArticle(String(p?.sku ?? '').trim())
    const qty = parseInt(p?.quantity ?? '1', 10) || 1

    if (!sku) {
      skipped.push(`(no sku) "${p?.name}"`)
      continue
    }

    items.push({
      order_id:    orderId,
      source:      'tilda',
      article:     sku,
      qty,
      order_date:  orderDate,
      ship_status: 'pending',
      ship_date:   '',
      title:       String(p?.name ?? '').trim(),
      lead_id:     '',
      priority:    '',
    })
  }

  if (skipped.length > 0) {
    logger.warn({ orderId, skipped }, 'Tilda webhook: products without sku skipped')
    sendAlert(
      `Tilda webhook: заказ ${orderId} — ${skipped.length} позиц. без SKU пропущены: ${skipped.join(', ')}`,
      { tag: 'tilda', level: 'low', code: 'TILDA_WEBHOOK_NO_SKU' }
    ).catch(() => {})
  }

  if (items.length === 0) return

  void createOrderItemsIfNew(orderId, items)
    .then(result => {
      if (result === 'created') logger.info({ orderId, count: items.length }, 'Tilda webhook: shipment_items created')
      else logger.info({ orderId }, 'Tilda webhook: order already in sheet, skipped duplicate')
    })
    .catch((e: any) => {
      logger.error({ orderId, err: e?.message }, 'Tilda webhook: failed to write shipment_items')
      sendAlert(
        `Tilda webhook: не удалось записать позиции заказа ${orderId} в shipment_items: ${e?.message}`,
        { tag: 'tilda', level: 'moderate', code: 'TILDA_WEBHOOK_SHEET_FAILED' }
      ).catch(() => {})
    })
}
