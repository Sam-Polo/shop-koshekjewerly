import type { Request, Response } from 'express'
import pino from 'pino'
import { sendAlert } from './alerts.js'
import { markOrderAsSent } from './shipment-items-sheet.js'

const logger = pino()

// amoCRM sends stage-change webhooks as x-www-form-urlencoded with bracket notation:
//   leads[status][0][id]=<lead_id>&leads[status][0][status_id]=<new_status>&...
// Express urlencoded({ extended: true }) parses this into nested objects.

const PIPELINE_ID   = 10993830
const STAGE_SENT    = 86462242   // Отправлен
const STAGE_DONE    = 142        // Завершён (success)
const STAGE_RETURN  = 86423894   // ВОЗВРАЩЕН
const FIELD_ORDER_NUMBER = 774543

const SENT_STAGES   = new Set([STAGE_SENT, STAGE_DONE])
const RETURN_STAGES = new Set([STAGE_RETURN])

function getAmoBase() {
  return `https://${process.env.AMOCRM_SUBDOMAIN}.amocrm.ru`
}

function getAmoToken() {
  return process.env.AMOCRM_ACCESS_TOKEN ?? ''
}

async function fetchLeadOrderNumber(leadId: number): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(
      `${getAmoBase()}/api/v4/leads/${leadId}?with=custom_fields`,
      { headers: { Authorization: `Bearer ${getAmoToken()}` }, signal: ctrl.signal }
    )
    clearTimeout(timer)
    if (!resp.ok) return null
    const lead: any = await resp.json()
    const cf: any[] = lead?.custom_fields_values ?? []
    const field = cf.find((f: any) => Number(f.field_id) === FIELD_ORDER_NUMBER)
    const v = field?.values?.[0]?.value
    return v ? String(v) : null
  } catch {
    clearTimeout(timer)
    return null
  }
}

export function handleAmoCrmWebhook(req: Request, res: Response): void {
  // shared-secret check
  const secret = process.env.AMOCRM_WEBHOOK_SECRET
  if (secret && req.query.secret !== secret) {
    res.status(403).json({ error: 'forbidden' })
    return
  }

  res.status(200).json({ ok: true }) // ACK immediately

  const body: any = req.body
  // amoCRM sends leads[status][0][...] for stage-change events
  const statusLeads: Record<string, any> = body?.leads?.status ?? {}

  if (Object.keys(statusLeads).length === 0) return // not a stage-change event

  void (async () => {
    for (const key of Object.keys(statusLeads)) {
      const lead = statusLeads[key]
      const leadId    = Number(lead?.id)
      const pipelineId = Number(lead?.pipeline_id)
      const statusId  = Number(lead?.status_id)

      if (pipelineId !== PIPELINE_ID) continue
      if (!SENT_STAGES.has(statusId) && !RETURN_STAGES.has(statusId)) continue

      logger.info({ leadId, statusId }, 'amoCRM webhook: stage change in our pipeline')

      const orderId = await fetchLeadOrderNumber(leadId)
      if (!orderId) {
        logger.warn({ leadId }, 'amoCRM webhook: order number not found in lead')
        sendAlert(
          `amoCRM webhook: лид ${leadId} сменил этап на ${statusId}, но поле 774543 (№ заказа) пусто — shipment_items не обновлён`,
          { tag: 'amocrm', level: 'moderate', code: 'AMOCRM_WEBHOOK_NO_ORDER_ID' }
        ).catch(() => {})
        continue
      }

      const shipDate = new Date().toISOString().slice(0, 10)
      const newStatus = SENT_STAGES.has(statusId) ? 'sent' : 'returned'

      try {
        const updated = await markOrderAsSent(orderId, shipDate)
        logger.info({ leadId, orderId, newStatus, updated }, 'amoCRM webhook: shipment_items updated')
      } catch (e: any) {
        logger.error({ leadId, orderId, err: e?.message }, 'amoCRM webhook: failed to update shipment_items')
        sendAlert(
          `amoCRM webhook: не удалось обновить статус отправки для заказа ${orderId}: ${e?.message}`,
          { tag: 'amocrm', level: 'moderate', code: 'AMOCRM_WEBHOOK_SHEET_UPDATE_FAILED' }
        ).catch(() => {})
      }
    }
  })()
}
