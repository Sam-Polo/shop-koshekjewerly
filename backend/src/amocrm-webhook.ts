import type { Request, Response } from 'express'
import pino from 'pino'
import { sendAlert } from './alerts.js'
import { upsertOrderItems, markOrderStatus, type ShipmentItem, type ShipStatus, type ShipSource } from './shipment-items-sheet.js'
import { parseAmoCrmComposition, normalizeArticle } from './shipment-items-parser.js'

const logger = pino()

const PIPELINE_ID = 10993830

// stage → ship_status mapping (same as import script)
const STAGE_MAP: Record<number, ShipStatus | 'skip'> = {
  86423882: 'pending',  // Неразобранное
  86486222: 'pending',  // ПРИОРИТЕТНЫЙ ЗАКАЗ
  86423886: 'pending',  // НОВЫЙ, ЖДЕТ ОТПРАВКИ
  86486582: 'in_work',   // В РАБОТЕ
  86486586: 'assembled', // Собран
  86462242: 'sent',     // Отправлен
  86423894: 'returned', // ВОЗВРАЩЕН
  142:       'sent',    // Завершён
  143:       'skip',    // Закрыто
}

const FIELD_ORDER_NUMBER = 774543
const FIELD_COMPOSITION  = 774547
const FIELD_SOURCE       = 770993
const FIELD_ORDER_DATE   = 770485
const ENUM_TELEGRAM      = 998663
const ENUM_MAX           = 998667

function getAmoBase() {
  return `https://${process.env.AMOCRM_SUBDOMAIN}.amocrm.ru`
}

function getAmoToken() {
  return process.env.AMOCRM_ACCESS_TOKEN ?? ''
}

async function fetchLead(leadId: number): Promise<any | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(
      `${getAmoBase()}/api/v4/leads/${leadId}?with=custom_fields`,
      { headers: { Authorization: `Bearer ${getAmoToken()}` }, signal: ctrl.signal }
    )
    clearTimeout(timer)
    if (!resp.ok) return null
    return resp.json()
  } catch {
    clearTimeout(timer)
    return null
  }
}

function readField(lead: any, fieldId: number): string | null {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.value
  return v !== undefined && v !== null && v !== '' ? String(v) : null
}

function readFieldEnum(lead: any, fieldId: number): number | null {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.enum_id
  return v !== undefined ? Number(v) : null
}

function readFieldDate(lead: any, fieldId: number): string {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.value
  if (v && Number(v) > 0) return new Date(Number(v) * 1000).toISOString().slice(0, 10)
  return ''
}

function sourceFromEnum(enumId: number | null): ShipSource {
  if (enumId === ENUM_TELEGRAM) return 'telegram'
  if (enumId === ENUM_MAX) return 'max'
  return 'tilda'
}

export function handleAmoCrmWebhook(req: Request, res: Response): void {
  const secret = process.env.AMOCRM_WEBHOOK_SECRET
  if (secret && req.query.secret !== secret) {
    res.status(403).json({ error: 'forbidden' })
    return
  }

  res.status(200).json({ ok: true })

  const body: any = req.body
  const statusLeads: Record<string, any> = body?.leads?.status ?? {}
  if (Object.keys(statusLeads).length === 0) return

  void (async () => {
    for (const key of Object.keys(statusLeads)) {
      const lead = statusLeads[key]
      const leadId     = Number(lead?.id)
      const pipelineId = Number(lead?.pipeline_id)
      const statusId   = Number(lead?.status_id)

      if (pipelineId !== PIPELINE_ID) continue

      const newStatus = STAGE_MAP[statusId]
      if (!newStatus || newStatus === 'skip') continue

      logger.info({ leadId, statusId, newStatus }, 'amoCRM webhook: stage change')

      const fullLead = await fetchLead(leadId)
      if (!fullLead) {
        logger.warn({ leadId }, 'amoCRM webhook: failed to fetch lead')
        continue
      }

      const orderId        = readField(fullLead, FIELD_ORDER_NUMBER)
      const rawComposition = readField(fullLead, FIELD_COMPOSITION)
      const sourceEnum     = readFieldEnum(fullLead, FIELD_SOURCE)
      const source         = sourceFromEnum(sourceEnum)
      const effectiveOrderId = orderId ?? `AMO-${leadId}`
      const orderDate      = readFieldDate(fullLead, FIELD_ORDER_DATE)
        || new Date(fullLead.created_at * 1000).toISOString().slice(0, 10)
      const shipDate       = (newStatus === 'sent' || newStatus === 'returned')
        ? new Date().toISOString().slice(0, 10)
        : ''

      // build items from composition (needed only for new orders)
      let items: ShipmentItem[] = []
      if (rawComposition) {
        const { items: parsed } = parseAmoCrmComposition(rawComposition)
        items = parsed.map(p => ({
          order_id:    effectiveOrderId,
          source,
          article:     normalizeArticle(p.article),
          qty:         p.qty,
          order_date:  orderDate,
          ship_status: newStatus,
          ship_date:   shipDate,
        }))
      }

      try {
        const result = await upsertOrderItems(effectiveOrderId, newStatus, items, shipDate)
        logger.info({ leadId, effectiveOrderId, newStatus, result }, 'amoCRM webhook: sheet updated')
      } catch (e: any) {
        logger.error({ leadId, effectiveOrderId, err: e?.message }, 'amoCRM webhook: sheet update failed')
        sendAlert(
          `amoCRM webhook: не удалось обновить учёт для заказа ${effectiveOrderId}: ${e?.message}`,
          { tag: 'amocrm', level: 'moderate', code: 'AMOCRM_WEBHOOK_SHEET_UPDATE_FAILED' }
        ).catch(() => {})
      }
    }
  })()
}
